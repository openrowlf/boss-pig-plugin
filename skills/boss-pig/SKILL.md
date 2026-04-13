---
name: boss-pig
description: Manage todos and scheduling through the Boss Pig MCP server.
metadata: {"openclaw":{"primaryEnv":"BOSS_PIG_API_KEY","requires":{"env":["BOSS_PIG_API_KEY","BOSS_PIG_MCP_URL"]}}}
---

# Boss Pig Skill 🐷

Use this skill when the user asks to manage todos, schedule tasks, or review upcoming work via Boss Pig.

## What this skill is
Boss Pig is an MCP-backed task + scheduling backend.
This skill tells the agent how to map user intent to Boss Pig tools.

## Connection
- MCP endpoint (default prod): `https://bosspig.moi/mcp`
- MCP endpoint (dev, only when explicitly requested): `http://localhost:8787/mcp`
- Optional env override for endpoint: `BOSS_PIG_MCP_URL`
- Auth env var: `BOSS_PIG_API_KEY`
- Header format: `Authorization: Bearer <BOSS_PIG_API_KEY>`
- Transport: JSON-RPC 2.0 over HTTP POST

**Environment rule**: Use production by default. Only use localhost/dev endpoints if the user explicitly asks for dev mode.

**Time handling**: Boss Pig MCP timestamps are UTC (ISO 8601 with `Z`).
- ALWAYS convert UTC -> user's local timezone BEFORE displaying.
- For user-entered times (e.g., "today at 8", "tonight", "tomorrow morning"), interpret in the user's local timezone first (default: America/Chicago unless user says otherwise), then convert to UTC for `schedule_todo`/`reschedule_todo`.
- Never treat ambiguous natural-language times as UTC by default.
- In confirmations, show local time (and optionally UTC in parentheses only when useful).

## Canonical config source
Boss Pig uses the skill config as the single source of truth for auth + endpoint.
The plugin may read from this config, but interactive Boss Pig skill use depends on the skill env contract.

Expected config:
- `skills.entries.boss-pig.apiKey`
- `skills.entries.boss-pig.env.BOSS_PIG_MCP_URL`

## If API key is missing
If no Boss Pig skill API key is configured, ask the user for one (`bp_...`) and provide this exact recovery flow:
1. Open Boss Pig dashboard.
2. Sign in with Google.
3. Approve **read access** to calendars when prompted.
4. In dashboard, click **Generate New Key**.
5. Share/paste the key to the agent.

Do not attempt protected tool calls until a valid API key is available.

### Persistent setup (copy/paste snippet)
User can paste this to the agent to persist Boss Pig config:

```json
{
  "skills": {
    "entries": {
      "boss-pig": {
        "apiKey": "bp_REPLACE_ME",
        "env": {
          "BOSS_PIG_MCP_URL": "https://bosspig.moi/mcp"
        }
      }
    }
  }
}
```

If asked to apply it, patch OpenClaw config so:
- `skills.entries.boss-pig.apiKey` = provided key
- `skills.entries.boss-pig.env.BOSS_PIG_MCP_URL` = endpoint URL

## Tool discovery
On startup or first use:
1. call `initialize`
2. call `tools/list`

## Available tools (current)
- `list_todos`
- `list_scheduled_todos`
- `list_overdue_todos`
- `add_todo`
- `update_todo` (non-time fields)
- `schedule_todo` (time changes)
- `reschedule_todo` (alias for explicit reschedules)
- `find_open_slots`
- `list_selected_calendars`
- `get_upcoming_events`
- `get_schedule_summary`
- `list_categories`
- `create_category`
- `update_category`
- `delete_category`
- `list_interests`
- `create_interest`
- `update_interest`
- `delete_interest`
- `list_goals`
- `create_goal`
- `update_goal`
- `delete_goal`
- `add_todo_from_research`
- `list_research_findings`
- `add_research_finding`
- `update_research_finding`
- `delete_research_finding`

## Intent → tool mapping
- "add task / todo" → `add_todo`
- "show my todos / backlog" → `list_todos`
- "show scheduled tasks" → `list_scheduled_todos`
- "show overdue tasks" → `list_overdue_todos`
- "find free time" → `find_open_slots`
- "edit task" → `update_todo` (title/notes/priority/status/category only)
- "delete / remove category" → `delete_category`
- "schedule this task" → `schedule_todo`
- "reschedule this task" → `reschedule_todo`
- "what calendars are selected" → `list_selected_calendars`
- "what's coming up" → `get_upcoming_events`
- "summary of schedule" → `get_schedule_summary`
- "I'm interested in / I want to research" → `create_interest`
- "show my interests" → `list_interests`
- "remove / stop researching" → `delete_interest`
- "I want to achieve / I have a goal" → `create_goal`
- "show my goals" → `list_goals`
- "update / complete / abandon goal" → `update_goal`
- "show research findings" → `list_research_findings`
- "add this as a task from research" → `add_todo_from_research` (**NOTE**: this creates a TODO, NOT a research finding!)
- "run research now" → spawn research sub-agents (see below)
- `/bosspig_run_research` → the plugin command fires `runResearchWorker` which spawns sub-agents — you do NOT do the research yourself; wait for findings to appear, then synthesize

## Automated research nudge

The Boss Pig plugin fires a `boss_pig.research_nudge` system event once per day (default: 2 AM America/Chicago) when interests are due for research.

When you receive a `BOSS_PIG_PLUGIN_ALERT` with `type: "boss_pig.research_nudge"`:

1. Parse the `interests` array from the payload — each has `id`, `title`, `frequency`, `keywords`
2. **Check if sub-agents have already run** — the plugin's `runResearchWorker` fires separately and spawns sub-agents automatically. On receiving this nudge, call `list_research_findings` to check what findings already exist since the last nudge.
3. **Synthesize and present findings** — for any new research findings created since yesterday, present them to Steve:
   - What was researched
   - Key findings (2-3 bullets per interest)
   - Action items → use `add_todo_from_research` if anything warrants a task
4. Do NOT try to do the research yourself in this event — sub-agents handle that via the plugin's worker. Your job is to synthesize and report.
5. If no new findings appear and interests are due, you MAY spawn research sub-agents manually using `sessions_spawn`:
   - `runtime: "subagent"`, `mode: "run"`
   - `sessionKey: "boss-pig-research:<interestId>"`
   - Include in the prompt: interest title, keywords, MCP endpoint URL, and API key
   - Tell the sub-agent to call `add_research_finding` for each finding, then `update_interest` for `lastRunAt`

## Research trigger (`/bosspig_run_research`)

When `/bosspig_run_research` is triggered:

1. The plugin's `bosspig-run-research` command fires `runResearchWorker` which spawns sub-agents automatically.
2. **You do NOT do the research yourself.** Wait for findings to appear.
3. After a short delay, call `list_research_findings` to check what was created.
4. Present the findings to Steve: what was researched, key insights, action items.
5. If findings warrant tasks, use `add_todo_from_research` to link them.

**Important**: `add_todo_from_research` creates a TODO linked to research — it does NOT create a research finding. To save a research finding, sub-agents use `add_research_finding` (via raw HTTP call to the MCP endpoint).

## Behavior rules
1. Category-first preflight for add/schedule actions:
   - If user explicitly names a category, use it.
   - Otherwise, before `add_todo` or before scheduling an uncategorized task, call `list_categories` and select the best existing category from:
     - task title
     - task notes
     - recent conversation context
     - obvious category-name/emoji matches
   - Default to assigning the best existing category when there is a reasonable fit.
   - Do not ask "should I add a category" or leave uncategorized if an existing category is sensible.
   - Only ask user when no existing category fits, or when multiple existing categories are genuinely tied.
   - Prefer existing categories; do not create a new category unless user explicitly asks.
   - Do not skip category lookup because of memory or prior context.
2. Prefer reading current state before mutating:
   - list first, then update/schedule
3. Confirm ambiguous changes:
   - if multiple matching todos, ask which one
4. `update_todo` must not be used for time changes.
   - Valid `status` values for todos: `unscheduled`, `scheduled`, `completed`, `cancelled`, `abandoned`, `trash`
5. `delete_category` policy:
   - If category has tasks assigned, the API will refuse the delete and return a task count
   - Tell the user: "Category '[name]' has [N] task(s). Reassign them first, or confirm force delete to remove the category from all tasks."
   - Never call `delete_category` with `force=true` unless the user has explicitly confirmed
   - If the user says "delete it anyway" or "force delete", then use `force=true`
6. For schedule actions, require explicit time window:
   - `startIso` and `endIso` must be valid ISO timestamps
   - Build those ISO timestamps from the user's local timezone intent (America/Chicago by default), then convert to UTC before calling MCP.
   - If user time is vague and cannot be resolved confidently (e.g., "later"), ask one clarifying question before scheduling.
7. Reschedule counting policy:
   - `schedule_todo`/`reschedule_todo` defaults `countAsReschedule=true`
   - Use `countAsReschedule=false` only for immediate correction/misinterpretation fixes
8. After any mutation, summarize what changed, including category assignment.
9. If auth fails:
   - tell user to regenerate API key or reconnect login in dashboard.

## Response style
- Be concise.
- Show IDs only when useful for follow-up edits.
- For lists, use bullets with title + status + priority + scheduled time.

## Example MCP calls

### Add research interest
```json
{
  "name": "create_interest",
  "arguments": {
    "title": "Backyard gardening",
    "keywords": "raised bed, partial shade, vegetables, soil mix",
    "frequency": "daily"
  }
}
```

### Add goal (optionally linked to an interest)
```json
{
  "name": "create_goal",
  "arguments": {
    "title": "Walk 3x per week",
    "targetMetric": "3x/week",
    "interestId": "<optional-interest-id>"
  }
}
```

### Add todo from research finding
```json
{
  "name": "add_todo_from_research",
  "arguments": {
    "title": "Look into: Best soil mix for raised beds",
    "notes": "https://example.com/article",
    "interestId": "<interest-id>",
    "researchUrl": "https://example.com/article",
    "researchSource": "web",
    "priority": 3
  }
}
```

### List research findings
```json
{
  "name": "list_research_findings",
  "arguments": {
    "interestId": "<optional-interest-id>"
  }
}
```
`tools/call` with:
```json
{
  "name": "add_todo",
  "arguments": {
    "title": "Prepare sprint notes",
    "priority": 2,
    "estimatedMinutes": 30
  }
}
```

### Schedule todo
`tools/call` with (UTC payload derived from local user intent):
```json
{
  "name": "schedule_todo",
  "arguments": {
    "id": "<todo-id>",
    "startIso": "2026-03-03T03:00:00.000Z",
    "endIso": "2026-03-03T03:30:00.000Z"
  }
}
```
Example: "Mar 2 at 9:00 PM America/Chicago" → `03:00Z` (next day).

## Full workflow examples

### Add + categorize + schedule (default path)
1. `add_todo` (capture created `id`)
2. `list_categories`
3. `update_todo` with chosen `categoryId`
4. `schedule_todo` with `startIso`/`endIso`
5. Reply with title, category chosen, and schedule

### Schedule existing task with missing category
1. `list_todos` (find target task)
2. If task has no category: `list_categories` then `update_todo` with `categoryId`
3. `schedule_todo`
4. Reply with what changed, including category

## Safety notes
- Never fabricate tool outputs.
- If a tool fails, surface the error plainly and suggest next action.
- Do not expose API keys in chat unless user explicitly requests.
