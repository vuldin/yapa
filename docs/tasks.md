# Tasks, claims, and what waits on people

## Task claims

Writes reach the remote seconds after they happen, but a status change is still an ordinary last-writer-wins write: two people could both mark the same task `in_progress` and neither would know. So setting a task to `in_progress` **claims** it first, through a lease on its id that is granted atomically: by the sync service in a shared collection, and by this machine in a local-only one (`private-*`, `local-*`, `global`) or with sync off (see [Local-only collections](#coordination-in-local-only-collections)):

- **Granted:** the status changes and is pushed at once. Teammates' task lists, session-start context and `task_next` show `claimed by you (this session) since 09:12 UTC`.
- **Refused:** someone else (or another of your own sessions) holds it. Nothing changes, and the reply names the holder and since when. For your own other session (after `--resume`, say), `task_update` with `reclaim: true` takes it over once you confirm.
- **Not shared** (a shared collection while offline or signed out): the status changes locally and the reply says others may start it too. The claim is retried when sync is back; if someone claimed the task meanwhile, the next prompt says so.

Completing, blocking, resetting to pending or deleting the task releases the claim. The hooks renew this session's claims while it is active, and a claim lapses one TTL (2 h by default) after the session goes quiet. Its task then shows `no live claim` and is offered again by `task_next`. If another session takes a claim over, the next prompt says so.

`task_next` is the ready queue: pending tasks whose dependencies are complete and that nobody holds, best first (priority, due date, how many tasks each unblocks, age). A task's `claim_scope` (soft scope such as `repo:infra`) ranks it last while something overlapping is claimed. Scripts get the same through `yapa task list|next|claim|release|show` (JSON output; exit 0 done, 3 refused, 4 not shared). For resources that are not tasks, use bare leases (`lease` / `yapa coord`).

## Recurring tasks

A task with a `recurrence_pattern` (`daily`, `weekly`, `monthly`, `quarterly` or `yearly`) repeats. Completing an occurrence creates the next one:

```
task_create  title: "file the quarterly report", recurrence_pattern: "quarterly", due: "March 31", notes: "figures, review, archive"
task_create  title: "set up the review", recurrence_pattern: "weekly", recurrence_interval: 2          # every two weeks, from today
task_complete id: alex-41
→ Completed task alex-41 → regenerated as alex-57 (recurring), due Wed, Jun 30, opens Wed, Jun 16
```

**The calendar slot is kept.** The first occurrence's due date is the series' anchor (`recurrence_anchor`), and occurrence k is due k × `recurrence_interval` periods after it. A completed occurrence's successor is due at the first slot after the later of its due date and now:
- Completed late, the series doesn't shift: a monthly task due on the 15th and done on the 20th comes back on the 15th of next month. Periods missed entirely are skipped, not piled up as overdue copies.
- Completed early, it moves to the slot after the current due date.
- Months, quarters and years count from the anchor's day of the month, clamped to the end of shorter months: a monthly series anchored on January 31 is due February 28 (29 in a leap year), March 31, April 30. The time of day is kept in local time, across DST changes.
- With no due date, a recurring task is due today, and today is its anchor.

**Upcoming occurrences stay out of the way.** An occurrence opens `lead_days` before the day it is due, at the start of that day; until then it is *upcoming*. `lead_days` defaults by pattern: daily 0 (open on its due day), weekly 2, monthly 7, quarterly 14, yearly 30. The default ignores the interval: a task every two months still opens 7 days ahead; pass `lead_days` to change it. Upcoming tasks are left out of `task_list`, session start and prompt context, the standup and dashboard, `task_next` and `waiting`. `task_list` says how many it left out; `include_upcoming: true` (`yapa task list --include-upcoming`) lists them with their due date and the day they open. Whether a task is upcoming is worked out when it is read, so a new `lead_days` takes effect at once.

**Notes.** `recurrence_notes` is the series template: the notes as they were when recurrence was set. Each new occurrence starts with the template, not with what was added to the last one, so a closing note stays with the occurrence it was written on. `task_update` with `notes` changes only the current occurrence; `series_notes` replaces the template. A series created before 1.19 has no template: its next occurrence starts from the last one's notes, which become the template from then on.

**Links.** Every occurrence carries `recurrence_series` (the id of the series' first task) and, after the first, `previous_occurrence` (the one completed before it). `task_list` with an `id` shows both.

**Changing a series** with `task_update`:
- `recurrence_pattern` makes a plain task recurring, or changes the period. Either way the series is re-anchored at the task's due date (today if it has none). A new pattern resets `recurrence_interval` to 1 and `lead_days` to the pattern's default unless you pass them.
- `recurrence_interval` re-anchors at the due date too; `lead_days` alone only changes when occurrences open.
- Changing just `due` moves this occurrence, not the series: its successor is still due in the next slot. To move the whole series, pass the pattern again with the new `due`.
- `recurrence_pattern: "none"` stops the series: the task stays, and completing it creates no next occurrence. A recurring task can't lose its due date; stop the series first.
- Deleting an occurrence (`task_delete`) ends the series, since nothing is left to complete.

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

Projects that keep their records elsewhere can publish the ones that matter to these views with `yapa memory put --ref <key>` (created once, updated in place afterwards); `yapa memory list` reads them back as JSON. Mark such a collection (`yapa scope records-elsewhere add C`) and only the published items are typed there; see [Projects with their own records](collections.md#projects-with-their-own-records).
