# Second-user sync test

Proves cross-user sync end to end with two people: **Josh** (admin, already
syncing) and **one colleague** (new). About 20 minutes. Everything happens
in the scratch shared collection `project-yapa-pilot-test` and is deleted at
the end.

Placeholders: `<SERVICE_URL>` the sync service, `<colleague>` the colleague's
YAPA username (email local part), `<josh>` Josh's username.

The prompts below are typed into Claude Code. Ask Claude to show the raw
tool output when checking results.

## 0. Josh: seed the collection

Subscribing needs the collection to exist on the service, so Josh creates it.
Start Claude Code in a folder that maps to the collection (a `yapa-pilot-test`
folder under one of Josh's `project_roots`), or name the collection explicitly.

```sh
mkdir -p <JOSH_PROJECT_ROOT>/yapa-pilot-test && cd "$_" && claude
```

> Store a memory in collection project-yapa-pilot-test: "Pilot test seed memory from Josh. Safe to delete."
> Run the yapa sync tool with action now, then action collections.

Expected: `project-yapa-pilot-test` listed with 1 doc, `(subscribed)`.
Note the seed memory id (`<JOSH_MEMORY_ID>`).

## 1. Colleague: install with sync only

Follow [pilot-onboarding.md](pilot-onboarding.md) steps 1-4, but set only
`sync_enabled=true` and `sync_service_url=<SERVICE_URL>` (no project roots).
Restart Claude Code, then:

> Run the yapa sync tool with action status.

Expected: `Signed in as: <colleague> (<colleague>@<company-domain>)` and
`Connection: healthy`. If it says "not mapped to a YAPA user", Josh runs
`scripts/yapa-user.sh rename-conflict <email> <new-username>` and the
colleague retries.

## 2. Colleague: subscribe and backfill

> Subscribe me to project-yapa-pilot-test with the yapa sync tool.

Expected: `Subscribed to: project-yapa-pilot-test (backfilled 1 docs)`.

> List memories in collection project-yapa-pilot-test.

Expected: the seed memory, attributed to `<josh>`.

## 3. Colleague: write a memory and a task

> Store a memory in collection project-yapa-pilot-test: "Pilot test: the colleague's favorite broker setting is retention.ms=604800000."
> Create a task in collection project-yapa-pilot-test: "[pilot-test] Josh completes this task".
> Run the yapa sync tool with action now.

Expected: push reports 2 docs, no errors. Note the task id
(`<colleague>-<n>`, call it `<TASK_ID>`).

## 4. Josh: see it attributed on the next prompt

In the `yapa-pilot-test` folder session from step 0:

> What is the colleague's favorite broker setting? Show me the YAPA Context block you received.

Expected: the injected context lists the colleague's memory with
`, by <colleague>`, pulled by the prompt hook without a manual sync. (Using
another folder instead: the hit appears with `from project-yapa-pilot-test`
once the background sync has pulled it, or after `sync` action `now`.)

## 5. Josh: complete the colleague's task

> List open tasks in project-yapa-pilot-test.

Expected: `<TASK_ID>` shown `by <colleague>`.

> Complete task <TASK_ID>. Then run the yapa sync tool with action now.

## 6. Colleague: see the completion

> Run the yapa sync tool with action now, then show task <TASK_ID>.

Expected: status `done`. The task is still the colleague's (no `by` label on
their side); the service records Josh as its last editor (optional admin
check: `SELECT id, origin_user, last_editor FROM documents WHERE id = '<TASK_ID>';`
over the admin tunnel).

## 7. Colleague: try to delete Josh's memory

> Forget memory <JOSH_MEMORY_ID>. Then run the yapa sync tool with action now.

Expected on the colleague's side: the memory is gone locally and does not
come back after the sync (tombstoned).

Josh:

> Run the yapa sync tool with action collections. List memories in project-yapa-pilot-test.

Expected: the seed memory is still there, and the remote doc count did not
drop. Only the owner can delete a shared row.

## 8. Optional: secret check

Colleague:

> Store a memory in project-yapa-pilot-test: "test key AKIAABCDEFGHIJKLMNOP". Then sync now and show sync status.

Expected: the memory is stored locally but listed as refused (secret
detected) in `sync status`, and Josh never receives it. Forget it afterwards.

## 9. Cleanup

Each person deletes their own items; owner deletes propagate.

Colleague:

> Forget my pilot-test memory and delete task <TASK_ID> in project-yapa-pilot-test. Sync now.

Josh (on the next pull, the colleague's items disappear from Josh's machine):

> List memories and tasks in project-yapa-pilot-test.

Expected: only Josh's seed memory remains. Then both run:

> Delete collection project-yapa-pilot-test.

`collection_delete` deletes your own rows on the service, drops teammates'
copies locally only, and unsubscribes you. Josh runs it last, as the owner of
the seed memory. Finally:

> Run the yapa sync tool with action collections.

Expected: `project-yapa-pilot-test` is no longer listed. Josh: remove the
`yapa-pilot-test` folder.

## Results checklist (paste back in the pilot thread)

```
Second-user sync test - <date> - colleague: <colleague>, plugin version: <x.y.z>
[ ] 1 colleague status shows "Signed in as: <colleague>" + Connection: healthy
[ ] 2 subscribe backfilled Josh's seed memory (by <josh>)
[ ] 3 colleague pushed memory + task, no errors
[ ] 4 Josh's next prompt injected the memory "by <colleague>" (no manual sync)
[ ] 5 Josh saw <TASK_ID> by <colleague> and completed it
[ ] 6 colleague saw <TASK_ID> as done after sync
[ ] 7 colleague's forget removed Josh's memory locally only; Josh still has it
[ ] 8 (optional) secret refused, stayed local, listed in sync status
[ ] 9 cleanup done; collection gone from `sync collections`
Notes / errors (paste sync status output for any failure):
```
