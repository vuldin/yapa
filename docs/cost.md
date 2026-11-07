# Token cost

What YAPA adds to a session's token bill, and what it can save. The numbers below were measured, not modeled, except where marked as an estimate.

**The data:**
- 27 Claude Code sessions, 156 active hours. Gaps over 5 minutes count as idle.
- One user, mostly Opus, on YAPA 1.14 to 1.16 in November 2026.
- The numbers come from the token usage the transcripts record for every request.

Your numbers will differ with the model, how long your context grows, and how much you talk to the agent.

## The short answer

| | Per active hour | Share of the session's cost |
|---|---|---|
| The session itself | ~5.7M input-token equivalents (~$16 at Opus 5.5 list prices) | 100% |
| What YAPA adds to the session's context | ~190k equivalents (~$0.55) | **~3.4%** (median session 2.6%, range 0.7–6.5%) |
| The capture after each turn (a separate Haiku call) | ~0.2M Haiku equivalents (~$0.02) | ~0.1% |
| Embeddings (MiniLM, in-process) | 0 tokens, $0 | 0% |

**Input-token equivalents** put every kind of token on one scale, the base input price:
- a token written to the prompt cache counts 2 (1-hour cache) or 1.25 (5-minute cache);
- a token read from the cache counts 0.1;
- an output token counts 5.

These are Anthropic's list-price ratios. One session hour made about 116 requests that re-read about 390k tokens of context each, so cache reads dominate the bill. Anything that stays in context gets cheaper per request but is paid for on every request.

## Where YAPA's share comes from

Each block YAPA adds to the context is written to the cache once, then read again on every later request until the context is compacted.

| Source | Per active hour | Tokens each | Share of session cost |
|---|---|---|---|
| Prompt recall (`# YAPA Recall`, three hits) | ~13 | ~370 | 1.5% |
| YAPA tool calls (inputs and results) | ~13 | ~340 | 1.4% |
| Session start (rules and context) | ~1 | ~1,300 | 0.5% |
| Loading YAPA tool schemas (deferred tools) | <1 | ~50 | <0.1% |

Prompt recall is the largest part, because it happens on every prompt. Recall adds hits to every prompt, including weak matches. In this data the agent visibly used a recalled memory in about 8% of turns, by citing its id or quoting it. The rate falls as matches get weaker: 4–6% of hits closer than distance 0.5 were used, against 1–2% beyond 0.7.

## The capture after each turn

After each turn, YAPA asks a small model (Claude Haiku, through `claude -p` when no curation key is set) up to three things:
- what the turn found (the extractor, ~2k tokens);
- whether the turn settled any open decision or question (follow-through, ~3k tokens, when there are open items);
- whether a new memory duplicates or replaces an old one (the resolver, ~2k tokens per candidate that has near neighbors).

That's about 7k Haiku tokens a turn.

- A real extractor call on 9.5KB of turn text measured 2.9k new tokens, 1.2k cached tokens and 4 output tokens, costing $0.0006.
- At about 13 turns an hour, the capture costs about $0.02 an hour.
- On a Claude subscription it counts against your plan's usage instead of dollars.

## MiniLM

Embeddings run in-process with MiniLM, so they use no API tokens at all. What that saves is small in money terms. Roughly 2k tokens are embedded per turn (an estimate: recall queries, capture candidates, their neighbor lookups); through a paid embedding API that would cost a fraction of a cent an hour. The real benefits are different:
- no API key;
- it works offline;
- no text leaves the machine to be embedded;
- no network round trip on every prompt.

MiniLM doesn't save LLM tokens.

## What it can save

Re-discovery is where the savings would be.

- **Without YAPA:** a fact found in one session (a root cause, a config value, a decision, why an approach failed) is gone in the next. The agent finds it again by reading files, running commands and asking you. It's lost across a compaction too, unless the summary kept it.
- **With YAPA:** it comes back as one ~370-token recall hit, or a memory linked to the task.

The data gives a break-even point, not a proof:

- **Typical turn costs:** a median turn costs ~100k input equivalents. A turn that produced at least one captured finding costs ~255k at the median; those turns stored 2.2 memories on average.
- **The break-even:** YAPA's ~190k equivalents an hour equal about two median turns, or three quarters of a finding-producing turn. So **YAPA pays for itself if recalled knowledge saves about two typical turns of work an hour.** One avoided re-investigation of a finding every 80 minutes or so would do it.
- **What the data shows:** about one turn per active hour visibly used a recalled memory. What each of those saved can't be measured from transcripts: the agent might have found the fact quickly anyway, or only after a long detour.
- **Sharing across users** multiplies the same effect, since one person's finding saves every teammate's re-discovery. But this data comes from a single user, so it says nothing about how often that happens.

The fair summary: YAPA costs about 3–4% of a session's tokens. It saves tokens whenever the work comes back to the same projects, customers or problems, because recall replaces re-discovery. It can't save anything on one-off work that never repeats.

## Keeping the cost down

- **Keep recall relevant.** Most of YAPA's share is recall that stays in context. Good collections help: specific project folders and private mappings keep the top hits on the work at hand.
- **Compaction resets it.** After a compaction, earlier recall blocks are summarized away instead of being re-read.
- **Turn off the per-turn capture** (`response_capture: false`) if you don't want the Haiku calls. You lose the automatic findings and the decisions recorded from your answers.
