# Token cost

What YAPA adds to a session's token bill, and what it can save, from one user's real sessions.

**How it was measured:**
- **Session totals are measured.** Claude Code transcripts record the token usage of every request.
- **YAPA's part is computed.** It's computed from the text YAPA added to the context, at 2.34 bytes per token. That ratio was measured on a real call, and it matches the median of 1,574 tool results, where each result's size could be compared with how much the context grew. It's then priced with a model of the prompt cache, described below.
- **The capture after each turn is estimated.** Those calls aren't saved in transcripts.

**The data:**
- 27 Claude Code sessions with at least 15 minutes of activity, October 25 to November 6, 2026.
- 157 active hours. A gap between transcript events counts up to 5 minutes, so unattended `/loop` sessions count too.
- Mostly Opus 5.5 (Sonnet was about 10% of the hours and 7% of the cost), on YAPA 1.14 to 1.16.
- Subagent transcripts are left out of both sides.

Your numbers will differ with the model, how long your context grows, and how much you talk to the agent.

## The short answer

| | Per active hour | Share of the session's cost |
|---|---|---|
| The session itself | ~5.7M input-token equivalents (~$16 at Opus 5.5 list prices) | 100% |
| What YAPA adds to the session's context | ~270k equivalents (~$0.80) | **~4.75%** (median session 3.6%, range 1–9%) |
| The capture after each turn (a separate Haiku call; estimate) | ~0.3M Haiku equivalents (~$0.03) | ~0.15% |
| Finding relevant memories (semantic search, MiniLM in-process) | 0 tokens | 0% (see [Semantic search](#semantic-search-and-minilm)) |

**Input-token equivalents** put every kind of token on one scale, the base input price:
- a token written to the prompt cache counts 2 (1-hour cache) or 1.25 (5-minute cache);
- a token read from the cache counts 0.1;
- an output token counts 5.

These are Anthropic's list-price ratios. One session hour made about 116 requests that re-read about 390k tokens of context each, so cache reads are about 80% of the bill. Anything that stays in context gets cheaper per request but is paid for on every request.

## Where YAPA's share comes from

Each block YAPA adds is written to the cache once, then read again on every later request until the context is compacted.

| Source | Per active hour | Tokens each | Share of session cost |
|---|---|---|---|
| Prompt recall (`# YAPA Recall`: header and three hits) | ~13 | ~520 | 2.1% |
| YAPA tool calls (inputs and results) | ~13 | ~470 | 2.0% |
| Session start (rules and context) | ~1 | ~1,860 | 0.7% |
| YAPA's tool names in the deferred-tool list, and loading their schemas | every request; <1 load | — ; ~800 a load | ~0.2% (not in the total above) |

Two simplifications make YAPA's share slightly low:
- a block re-written after its 1-hour cache entry expires is counted only once;
- tool inputs (which the model writes) are priced as cache writes, not output.

**How much of recall gets used.** Recall adds hits to every prompt, including weak matches. The agent visibly used a recalled memory in about 8% of turns. That's measured by the turn mentioning the hit's id, or sharing three long words with its preview. The measure can overcount: shared project vocabulary, a related chunk's id, or YAPA's own tool calls on the memory all register. It can also undercount: a memory that shaped the answer without being quoted doesn't. The rate falls as matches get weaker: 4–6% of hits closer than distance 0.5 were used, against 1–2% beyond 0.7.

### What the measurements changed (YAPA 1.17)

Two things in this data changed how YAPA builds its context. The effects below are estimates from the same transcripts, to be measured again on new sessions.

- **Recall no longer repeats itself.** 57% of recall hits, 48% of all recall text, had already been shown earlier in the same session and were still in context. Such a hit is now named in one short line (its id and a 60-character preview, about 90 characters) instead of being injected again. Replaying the transcripts with the new rule, recall text falls by about 30%, so recall's share drops from about 2.1% to about 1.5%.
- **Session start reaches the model in full.** Claude Code passes the model at most 10,000 characters of a hook's context; past that, only a 2,000-character preview. The standing rules (7.2KB) and the context together ran over in about half of the session starts in this window. In those sessions the model saw part of the rules and none of the open tasks, waiting items or top memories.
  - The rules are now the MCP server's instructions: about 3,600 characters, or 1,500 tokens.
  - The context is kept under a 9,000-character budget.
  - Session start now averages about 1.8 times what it did, since nothing is cut off any more, so its share rises from about 0.7% to about 1.2%. That's the price of the context actually arriving. Subagents, left out here, also carry the instructions now, about 0.05% more.

Together they bring YAPA's share to about **4.6%**, a little lower than before. More of it is now context the model actually gets, and less is repeated text.

## The capture after each turn

After each turn, YAPA asks a small model (Claude Haiku, through `claude -p` when no curation key is set) up to three things:
- what the turn found (the extractor);
- whether the turn settled any open decision or question (follow-through, when there are open items);
- whether a new memory duplicates or replaces an old one (the resolver, for each candidate that has near neighbors).

Measured once: an extractor call on 6.2KB of turn text, plus its 3.3KB system prompt, used about 4.1k input tokens, 1.2k of them from cache, and 4 output tokens. It cost $0.0006. Estimated from turn sizes in the transcripts, a turn's three calls come to about 13k Haiku tokens, $0.002–0.003 a turn, or about $0.03 an hour at 13 turns. On a Claude subscription this counts against your plan's usage instead of dollars.

## Semantic search and MiniLM

No LLM reads an embedding. YAPA turns each memory and each prompt into a vector and picks the closest memories with arithmetic (cosine distance) on the CPU. Only the few memories it picks enter the session: about 130 tokens a hit, and about 520 a prompt with the recall header.

**What it replaces.** Without semantic search, there are two other ways to find what's relevant:
- **Keyword search** costs no tokens either, but it misses anything phrased differently.
- **An LLM reads the memories and chooses.** The store measured here held 4,209 live memories, about 2.2M tokens of text. A single active collection was 350k to 750k tokens, so a small model reading one collection per prompt would cost roughly $0.035–0.075 a prompt on Haiku (estimate), and the whole store doesn't fit in one call. A real system wouldn't do this on every prompt; it shows the order of magnitude semantic search avoids.

**What MiniLM adds.** MiniLM is the embedding model that runs this search locally, with no API key and no tokens. A paid embedding API could do the same kind of search with a different model. Roughly 2k tokens are embedded per turn, about 26k an hour (an estimate covering recall queries, capture candidates and their neighbor lookups). At $0.02–0.13 per million tokens that would cost $0.0005–0.003 an hour, so MiniLM's saving is small in money. Its other benefits:
- it works offline;
- no text leaves the machine to be embedded;
- no network round trip on every prompt.

## What it can save

Re-discovery is where the savings would be.

- **Without YAPA:** a fact found in one session (a root cause, a config value, a decision, why an approach failed) is gone in the next. The agent finds it again by reading files, running commands and asking you. It's lost across a compaction too, unless the summary kept it.
- **With YAPA:** it comes back as a recall hit of about 130 tokens, or as a memory linked to the task.

The data gives a break-even point, not a proof:

- **Typical turn costs:** a median turn costs ~105k input equivalents. A turn that stored at least one memory costs ~280k at the median, and those turns stored 2.2 memories on average, so about 130k per memory.
- **The break-even:** YAPA's ~270k equivalents an hour equal about 2.6 median turns, or about two memories' worth of discovery. So **YAPA pays for itself if recalled knowledge saves about two to three typical turns of work an hour**, for example two avoided re-discoveries an hour.
- **What the data shows:** about one turn per active hour visibly used a recalled memory. What each of those saved can't be measured from transcripts: the agent might have found the fact quickly anyway, or only after a long detour.
- **Sharing across users** multiplies the same effect, since one person's memory can save every teammate's re-discovery. But this data comes from a single user, so it says nothing about how often that happens.

The fair summary:
- YAPA costs about 4.5–5% of a session's tokens.
- It can save more than that when the work keeps coming back to the same projects, customers or problems, because a recalled memory replaces re-discovering it. The data shows about one visible reuse an hour, but not how much work each one saved, so it doesn't show whether the savings exceed the cost.
- It can't save anything on one-off work that never repeats.

## Keeping the cost down

- **Keep recall relevant.** Recall that stays in context is the largest part of YAPA's share. Good collections help: specific project folders and private mappings keep the top hits on the work at hand. Hits already shown in the session cost one short line each.
- **Compaction resets it.** After a compaction, earlier recall blocks are summarized away instead of being re-read, and recall shows its hits in full again.
- **Session start has a budget.** `YAPA_SESSION_START_MAX_CHARS` (default 9,000) caps the session-start context. A lower value shrinks it further: fewer tasks and waiting items, and top memories dropped first.
- **Turn off the per-turn capture** (`response_capture: false`) if you don't want the Haiku calls. You lose the automatic findings and the decisions recorded from your answers.
