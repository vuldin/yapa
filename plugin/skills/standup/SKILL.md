---
name: standup
description: Standup report from YAPA durable tasks - overdue, due today, in progress, blocked. Use when the user asks for a standup, daily summary, or "what is on my plate".
---

# YAPA Daily Standup

Produce a standup from YAPA's durable task store. Steps:

1. Call `task_list` with status `in_progress`, and again with status `blocked`.
   Call `task_list` with no status filter to find overdue and due-today items
   (compare `due` dates against today).
2. If the user named a customer or project, pass the matching `collection`
   (e.g. `customer-acme`) on those calls; otherwise use the active scope from
   the injected `# YAPA Context`, or aggregate across collections (omit
   `collection`) if the user asks for everything.
3. Format as markdown sections in this order: **Overdue**, **Due today**,
   **In progress**, **Blocked**. One checkbox line per task with its ID, title,
   and (for overdue) days overdue. Mark teammates' tasks with "(by <user>)".
   Omit empty sections.
4. Close with one sentence suggesting the single highest-priority next action,
   and offer to create or update tasks with `task_create` / `task_update`.
