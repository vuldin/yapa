# YAPA pilot feedback template

Report every pilot issue twice: a short reply in the pilot Slack thread (so
others can say "me too") and a YAPA task (so it is tracked). Never paste
customer secrets, tokens or passwords; `sync status` output is safe to share.

## Slack thread reply

```
*[pilot] <one-line summary>*
Severity: <S1 | S2 | S3 | S4>    Area: <install | auth | sync | recall | tasks | hooks | standup | docs | other>
Plugin version: <x.y.z>   OS: <macOS | Linux | WSL>   Claude Code: <version>
What happened: <1-2 lines>
Expected: <1 line>
Repro:
  1. <step>
  2. <step>
Sync status:
  <paste `sync` action `status` output>
YAPA task: <task id>
```

Feature ideas and "this felt off" notes are welcome too: use severity S4 and
area `ux`.

## YAPA task

Ask Claude to create it (it syncs to a shared collection the pilot admin
follows):

> Create a task in collection project-yapa titled "[pilot] <summary>" with tags pilot and area-<area>, priority <priority>, and these notes: ...

| Field | Value |
|---|---|
| title | `[pilot] <one-line summary>` |
| collection | `project-yapa` |
| tags | `pilot`, plus one area tag: `area-install`, `area-auth`, `area-sync`, `area-recall`, `area-tasks`, `area-hooks`, `area-standup`, `area-docs`, `area-ux`, `area-other` |
| priority | S1 -> `critical`, S2 -> `high`, S3 -> `medium`, S4 -> `low` |
| notes | the block below |

```
Severity: <S1-S4>
Area: <area>
Plugin version / OS / Claude Code version: <...>
Slack thread: <link>

What happened:
<...>

Expected:
<...>

Repro:
1. <...>
2. <...>
Frequency: <always | sometimes | once>

Sync status output:
<paste>

Workaround (if any):
<...>
```

## Severity

| Level | Meaning | Example |
|---|---|---|
| S1 | data loss, data shown to the wrong people, or YAPA blocks Claude Code | a `private-*` memory visible to a teammate; a session hangs on every prompt |
| S2 | sync or a core feature broken for you, no workaround | cannot sign in; teammates' items never arrive |
| S3 | works with a workaround, or wrong but harmless | need `sync now` to see new items; wrong scope detected |
| S4 | cosmetic, docs, or an idea | confusing message; missing doc step |

S1: also message the pilot admin directly, and `claude plugin disable yapa@yapa`
if it keeps happening.
