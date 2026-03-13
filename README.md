# Boss Pig Plugin for OpenClaw

Lightweight OpenClaw plugin that periodically checks Boss Pig MCP for overdue tasks and tracks cooldown/escalation state.

## Bundled skill

This plugin repo includes a bundled AgentSkill at:

- `skills/boss-pig/SKILL.md`

After install, keep this skill available in your agent skill discovery paths (or symlink/copy it into your managed skills location if needed).

## What v0.1 does

- Periodic checks via plugin service (`checkEveryMinutes`)
- Calls MCP tool: `list_overdue_todos`
- Persists state to avoid spam (`overdue-alert-state.json`)
- Escalation-aware per task:
  - gentle: reschedule 0-1
  - firm: 2-3
  - intervention: 4+
- Registers:
  - Gateway method: `bosspig.status`
  - Command: `/bosspig-check` (optional via `manualCommandEnabled: true`)
  - Agent tools: `boss_pig_*` wrappers for core Boss Pig MCP methods

> Note: v0.1 supports session-event nudges and optional direct delivery fallback. Command `/bosspig-check` returns the current alert text for manual checks.

## Install

```bash
openclaw plugins install @openrowlf/openclaw-plugin-boss-pig
```

## Configure

Use `skills.entries.boss-pig` as the canonical auth source (for interactive skill + plugin).
Plugin config still controls cadence/delivery behavior.

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
  },
  "plugins": {
    "entries": {
      "boss-pig": {
        "enabled": true,
        "config": {
          "enabled": true,
          "agentId": "bosspig",
          "delivery": {
            "channel": "",
            "to": ""
          },
          "checkEveryMinutes": 15,
          "cooldownMinutes": 720,
          "maxItems": 3,
          "manualCommandEnabled": false,
          "quietHours": {
            "enabled": false,
            "start": "23:00",
            "end": "08:00",
            "timezone": "America/Chicago"
          }
        }
      }
    }
  }
}
```

Restart gateway after config changes.

## Commands

- `/bosspig-check` – run overdue check now

## Gateway method

- `bosspig.status` – inspect plugin config + state

## Plugin tools (`boss_pig_*`)

This plugin registers agent tools that wrap MCP methods:

- `boss_pig_list_todos`
- `boss_pig_list_scheduled_todos`
- `boss_pig_list_overdue_todos`
- `boss_pig_list_categories`
- `boss_pig_create_category`
- `boss_pig_update_category`
- `boss_pig_add_todo`
- `boss_pig_update_todo`
- `boss_pig_schedule_todo`
- `boss_pig_reschedule_todo`
- `boss_pig_find_open_slots`
- `boss_pig_list_selected_calendars`
- `boss_pig_get_upcoming_events`
- `boss_pig_get_schedule_summary`

These tools are available when the plugin is enabled.

## State file

The plugin stores state at:

- `<stateDir>/boss-pig-plugin/overdue-alert-state.json`

This prevents repeated alerts inside cooldown windows unless severity/bucket changes.
