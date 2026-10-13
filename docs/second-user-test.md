# Second-user sync test

Two people work on the same project the way they normally would: open Claude
Code in the project folder, ask questions, and mention facts as they come up.
YAPA picks the collection from the folder, recalls what the team knows,
captures new facts and follow-ups, and syncs them through the service. About
20 minutes. Everything lives in the scratch collection
`project-yapa-pilot-test`, which is deleted at the end.

People: **Josh** (admin, already syncing) and **one colleague** (new). Both
need YAPA installed, configured and verified per
[pilot-onboarding.md](pilot-onboarding.md) first.

> **How to use the prompts below:** each **Type this message** block is a
> plain message to type into Claude Code (no leading `/`). Any similar
> wording works; Claude calls the YAPA tools for you. You do not need to name
> collections or tools.

## Setup (both)

Each person makes a `yapa-pilot-test` folder under one of their
`project_roots` and starts Claude Code there. That folder maps to the shared
collection `project-yapa-pilot-test` on both machines.

```sh
mkdir -p <YOUR_PROJECT_ROOT>/yapa-pilot-test && cd "$_" && claude
```

## 1. Josh shares what he knows about the project

**Type this message:**
```
For this project: we have one cluster, pilot-east, running Redpanda 25.3 with 3 brokers. The orders topic uses cleanup.policy=compact.
```

Expected: Claude asks to confirm creating the new collection
`project-yapa-pilot-test` (normal for a brand-new project; confirm it), then
stores the facts. A couple of seconds later they are pushed to the service.

## 2. The colleague starts on the project

**Type this message:**
```
List all clusters for this project.
```

Expected: the answer names pilot-east (25.3, 3 brokers), marked `by <josh>`,
with no manual sync. This is the first-visit backfill: the prompt hook pulled
the project's history and now follows the collection.

If it says nothing is known, ask `Is my YAPA sync working?` and paste the
output in the pilot thread.

## 3. The colleague learns something and leaves a follow-up

**Type this message:**
```
I just checked pilot-east: the orders topic also has retention.ms=604800000 set. We should verify the compaction lag on orders before the next maintenance window.
```

Expected: a memory (the retention.ms fact) and a task (verify compaction
lag), both in `project-yapa-pilot-test`.

## 4. Josh asks about it later

**Type this message:**
```
Does this project have anything to do with retention.ms or compaction?
```

Expected: the answer includes the colleague's retention.ms note, marked
`by <colleague>`, pulled by the hook on this prompt.

**Type this message:**
```
What's still open for this project?
```

Expected: the compaction-lag task, `by <colleague>`.

## 5. Josh does the follow-up

**Type this message:**
```
I checked the compaction lag on orders, it's fine. That follow-up is done.
```

Expected: the task is completed.

## 6. The colleague forgets Josh's note (for themselves only)

**Type this message:**
```
The pilot-east cluster note from Josh is outdated for me, forget it.
```

Expected: Claude forgets it on the colleague's machine only (only the author
can delete a shared item). Then Josh asks:

**Type this message:**
```
What do we know about pilot-east?
```

Expected: Josh still has the note.

## 7. The colleague sees the update

**Type this message:**
```
Anything still open on this project?
```

Expected: the compaction-lag task is no longer open.

## 8. Optional: something that must not be shared (colleague)

**Type this message:**
```
The pilot-east admin login is AKIAABCDEFGHIJKLMNOP, keep that handy.
```

Expected: if Claude stores it, the service refuses it (secret detected) and
it stays only on the colleague's machine; Josh never sees it. Ask
`Is my YAPA sync working?` to see it listed as refused. Then:
`Forget that admin login note.`

## 9. Clean up

Colleague first:

**Type this message:**
```
We're done with the pilot test project. Remove what I added to YAPA for it.
```

Then Josh (last, as the owner of the remaining items):

**Type this message:**
```
We're done with the pilot test project. Delete its YAPA collection, including what's on the sync service.
```

Expected: `project-yapa-pilot-test` is removed. Both: delete the
`yapa-pilot-test` folder.

## Results checklist (paste back in the pilot thread)

```
Second-user sync test - <date> - colleague: <colleague>, plugin version: <x.y.z>
[ ] 1 Josh's pilot-east facts stored in project-yapa-pilot-test
[ ] 2 colleague's first question answered from Josh's facts (by <josh>), no manual sync
[ ] 3 colleague's retention.ms memory + compaction-lag task stored
[ ] 4 Josh's next questions showed both (by <colleague>), no manual sync
[ ] 5 Josh completed the task
[ ] 6 colleague's forget removed Josh's note for the colleague only; Josh still has it
[ ] 7 colleague saw the task as done
[ ] 8 (optional) secret refused, stayed local, listed in sync status
[ ] 9 cleanup done; collection gone
Notes / errors (paste the "Is my YAPA sync working?" output for any failure):
```
