# Boss Pig Plugin for OpenClaw

Lightweight OpenClaw plugin that periodically checks Boss Pig MCP for overdue tasks and tracks cooldown/escalation state.

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
  - Command: `/bosspig-check`

> Note: v0.1 writes automatic alerts to plugin logs and state. Command `/bosspig-check` returns the current alert text for manual checks.

## Install

```bash
openclaw plugins install @openrowlf/openclaw-plugin-boss-pig
```

## Configure

```json
{
  "plugins": {
    "entries": {
      "boss-pig-plugin": {
        "enabled": true,
        "config": {
          "enabled": true,
          "mcpUrl": "https://bosspig.moi/mcp",
          "apiKey": "bp_REPLACE_ME",
          "checkEveryMinutes": 15,
          "cooldownMinutes": 720,
          "maxItems": 3,
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

## State file

The plugin stores state at:

- `<stateDir>/boss-pig-plugin/overdue-alert-state.json`

This prevents repeated alerts inside cooldown windows unless severity/bucket changes.
