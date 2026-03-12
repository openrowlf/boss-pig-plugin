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

**Time handling**: All timestamps from MCP are UTC (ISO 8601 with `Z`). ALWAYS convert to the user's local timezone BEFORE displaying. Do not show raw UTC times.

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

## Intent → tool mapping
- “add task / todo” → `add_todo`
- “show my todos / backlog” → `list_todos`
- “show scheduled tasks” → `list_scheduled_todos`
- “show overdue tasks” → `list_overdue_todos`
- “find free time” → `find_open_slots`
- “edit task” → `update_todo` (title/notes/priority/status/category only)
- “schedule this task” → `schedule_todo`
- “reschedule this task” → `reschedule_todo`
- “what calendars are selected” → `list_selected_calendars`
- “what’s coming up” → `get_upcoming_events`
- “summary of schedule” → `get_schedule_summary`

## Behavior rules
1. Prefer reading current state before mutating:
   - list first, then update/schedule
2. Confirm ambiguous changes:
   - if multiple matching todos, ask which one
3. `update_todo` must not be used for time changes.
4. For schedule actions, require explicit time window:
   - `startIso` and `endIso` must be valid ISO timestamps
5. Category auto-assignment:
   - If the user explicitly names a category, use it.
   - Otherwise, before `add_todo` or when preparing a task for scheduling, call `list_categories` and choose the best existing category from the real available category list using:
     - task title
     - task notes
     - recent conversation context
     - obvious category-name/emoji matches
   - Default to assigning the best existing category when there is a reasonable fit.
   - Do not ask "should I add a category" or leave the task uncategorized if an existing category is a sensible match.
   - Only ask the user if no existing category fits well, or if multiple existing categories are genuinely close and the choice is materially ambiguous.
   - Prefer existing categories; do not invent/create a new category unless the user explicitly asks.
6. Reschedule counting policy:
   - `schedule_todo`/`reschedule_todo` defaults `countAsReschedule=true`
   - Use `countAsReschedule=false` only for immediate correction/misinterpretation fixes
7. After any mutation, summarize what changed, including category assignment when relevant.
8. If auth fails:
   - tell user to regenerate API key or reconnect login in dashboard.

## Response style
- Be concise.
- Show IDs only when useful for follow-up edits.
- For lists, use bullets with title + status + priority + scheduled time.

## Example MCP calls

### Add todo
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
`tools/call` with:
```json
{
  "name": "schedule_todo",
  "arguments": {
    "id": "<todo-id>",
    "startIso": "2026-03-02T15:00:00.000Z",
    "endIso": "2026-03-02T15:30:00.000Z"
  }
}
```

## Safety notes
- Never fabricate tool outputs.
- If a tool fails, surface the error plainly and suggest next action.
- Do not expose API keys in chat unless user explicitly requests.
