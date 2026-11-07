# Tasks, claims, and what waits on people

## Task claims

Writes reach the remote seconds after they happen, but a status change is still an ordinary last-writer-wins write: two people could both mark the same task `in_progress` and neither would know. So setting a task to `in_progress` **claims** it first, through a lease on its id that is granted atomically: by the sync service in a shared collection, and by this machine in a local-only one (`private-*`, `local-*`, `global`) or with sync off (see [Local-only collections](#coordination-in-local-only-collections)):

- **Granted:** the status changes and is pushed at once. Teammates' task lists, session-start context and `task_next` show `claimed by you (this session) since 09:12 UTC`.
- **Refused:** someone else (or another of your own sessions) holds it. Nothing changes, and the reply names the holder and since when. For your own other session (after `--resume`, say), `task_update` with `reclaim: true` takes it over once you confirm.
- **Not shared** (a shared collection while offline or signed out): the status changes locally and the reply says others may start it too. The claim is retried when sync is back; if someone claimed the task meanwhile, the next prompt says so.

Completing, blocking, resetting to pending or deleting the task releases the claim. The hooks renew this session's claims while it is active, and a claim lapses one TTL (2 h by default) after the session goes quiet. Its task then shows `no live claim` and is offered again by `task_next`. If another session takes a claim over, the next prompt says so.

`task_next` is the ready queue: pending tasks whose dependencies are complete and that nobody holds, best first (priority, due date, how many tasks each unblocks, age). A task's `claim_scope` (soft scope such as `repo:infra`) ranks it last while something overlapping is claimed. Scripts get the same through `yapa task list|next|claim|release|show` (JSON output; exit 0 done, 3 refused, 4 not shared). For resources that are not tasks, use bare leases (`lease` / `yapa coord`).

## Coordination in local-only collections

`private-*`, `local-*` and `global` never leave your machine, and every collection stays local while sync is off. Coordination works there too, served by this machine instead of the sync service, with the same rules and answers:

- **Claims** (`task_update` to `in_progress`, `task_next` with `claim`, `yapa task claim`): a second session is refused with the holder and since when, and a claim that lapsed is offered again by `task_next`.
- **Leases** (`lease`, `yapa coord acquire|heartbeat|release|list`): keys, scope overlap, TTLs, reclaim and takeovers behave as on the service. The hooks renew this session's local leases too.
- **Counters** (`counter_next`, `yapa coord counter-next`) never hand out a value twice, and **task ids** never repeat between sessions on this machine, online or not.

The state lives in `~/.local/share/yapa/coord/` (`YAPA_LOCAL_COORD_DIR`), one small file per collection, changed under a lock file that every YAPA process on the machine respects. A grant from this machine says `(this machine)`; `yapa coord` adds `"local": true` to its JSON. Shared collections with sync on still go to the service, and when it can't be reached their claims are "not shared", because a teammate may hold the work.

Turning sync on or off moves shared collections between the two: a lease taken on this machine while sync was off isn't known to the service after you turn sync on (and the reverse), so finish or release claims before switching. An `in_progress` task with no claim on record (one started before 1.10, or by an older YAPA process still running) is offered again only after it has been untouched for two hours.

## Findings, decisions and what waits on people

A memory can say what kind of knowledge it holds, so it can be listed, waited on and kept current:

| `kind` | statuses | for |
|---|---|---|
| `finding` | open, resolved (with a `disposition`: decision, task, limitation, or no-action and a reason) | a result, root cause, retraction or trap |
| `decision` | needed, proposed, accepted, superseded, rejected | a choice; `needed` (with `options`, a `recommendation` and the `owner` who decides) is one only a person can make |
| `limitation` | open, mitigated, accepted, closed (with `exit_criteria`) | something that can't be done yet |
| `question` | open, answered (with the `owner` who must answer) | a question for a person or another team |
| `idea` | proposed, adopted, dropped | a change nobody has committed to |

They are created and kept current in the normal course of work:
- **When work closes.** `task_complete` takes `learned` (typed memories linked to the task) and `follow_ups` (new tasks); the reply says when nothing was recorded. `task_update` with `decision_needed` records a choice only a person can make, and the task waits on it (pending, `waits_on`): `task_next` skips it until the decision is recorded, then offers it again by itself.
- **After each turn** (`response_capture`, on by default; always on in DSH). The aux model types what it captures, and it judges the open decisions, questions and findings the turn touches (those the session's task waits on or recorded, and those near the turn). When the person chose, answered or settled one, it is updated with a dated note, and the judge has to quote the words of the turn that settle it. Only an item's owner settles a decision that names one (record a decision for someone outside YAPA with `memory_update`), and a question for another YAPA user is answered only in that user's turn; a move the rules don't allow (a finding resolved without a disposition, reopening an item) is dropped.
- **By hand.** `memory_update` records a decision (`status: accepted`, the choice as `note`) or an answer.

`waiting` (and `yapa waiting`) lists everything waiting on people; session start lists what waits on you. An `owner` is matched to a YAPA user case-insensitively (an email address by the part before the `@`); an owner who is no YAPA user (a customer, another team) is someone to ask, so the item waits on whoever recorded it (`for josh, ask Dana`). Triage tags on tasks: `auto` (an unattended session may do all of it), `needs-human` (a step only a person takes), `needs:<user>`; `task_next` never offers `needs-human` tasks, and `auto_only` offers only `auto` ones. When nothing is ready it offers cleanup items (`cleanup:triage`, `cleanup:findings`, `cleanup:compaction`), each claimable like a task; `cleanup:findings` also shows beside ready tasks once a collection holds `FINDINGS_CLEANUP_THRESHOLD` (default 20) of your open findings older than two days with no disposition. `yapa memory sweep-findings --collection C --save FILE` lists the ones that are only progress notes or superseded by a newer finding, decision or limitation, and `--apply --from FILE` resolves exactly that list as no-action once you've checked it. The `/yapa:work` skill runs the loop: take the next task, do it, record what it produced, complete it, repeat.

Projects that keep their records elsewhere can publish the ones that matter to these views with `yapa memory put --ref <key>` (created once, updated in place afterwards); `yapa memory list` reads them back as JSON.
