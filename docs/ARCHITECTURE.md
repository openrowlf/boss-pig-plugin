# Boss Pig Proactive Research Architecture

## Goals
1. Piggy monitors Steve's interests and does research without being asked
2. Piggy surfaces actionable findings proactively — unprompted
3. Piggy can identify new trend interests and suggest them to Steve

## What OpenClaw Provides (built-in)
- `registerService` — background worker loop (replaces our 15-min hack)
- `sessions_spawn` — isolated AI session for research (no AI cost on Piggy's session)
- Cron jobs — exact scheduling (2 AM research nudge, morning surfacing)
- Lifecycle hooks — inject research context into Piggy's prompt
- Memory files — Piggy's persistent memory / long-term context

## What the Plugin Owns

### D1 Tables

```
interests
  id, name, category, created_at, is_active

findings
  id, interest_id, title, summary, url, source, created_at, is_shared

suggested_interests  -- trends Piggy discovers
  id, name, category, reason, created_at, status (pending/approved/rejected)
```

### Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│  RESEARCH WORKER (registerService, every 6h)                │
│                                                             │
│  For each active interest:                                  │
│    sessions_spawn(isolated) → web search → write findings   │
│                                    ↓                        │
│                              D1 findings table              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2 AM NUDGE (cron) → wakes Piggy's session                 │
│  Piggy: load unshared findings → synthesize → send to Steve  │
│  → mark findings as shared                                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  MORNING CHECK-IN (9 AM cron, configurable)                 │
│  Piggy: any urgent todos? new trends? what's cookin'?     │
└─────────────────────────────────────────────────────────────┘
```

### Optional: Trend Discovery
```
Every 24h:
  sessions_spawn → search emerging trends
  → write to suggested_interests
  → if high confidence, auto-add to interests
  → else flag for Steve's review
```

## Key Design Decisions

1. **Research runs in isolated sessions** — doesn't burn Piggy's conversation context or AI budget
2. **Findings queue in D1** — Piggy reviews and decides what to surface, not the worker
3. **One outbound message per nudge** — Piggy synthesizes all new findings into one digest
4. **Interest graph is editable** — Steve can add/remove interests; Piggy can suggest new ones

## What to Build First

### Phase 1: Research Worker
- `registerService` tick loop (steal from existing 15-min hack)
- `interests` table + CRUD
- `findings` table
- Isolated research sessions writing to D1

### Phase 2: Piggy Surfacing
- 2 AM nudge already works — extend it to read D1 findings
- Piggy composes and sends the digest

### Phase 3: Trend Discovery
- Periodic emerging trend search
- `suggested_interests` table
- Piggy proposes → Steve approves/rejects

## Config Options (plugin config schema)
```json
{
  "researchIntervalHours": 6,
  "surfacingHour": 9,
  "maxFindingsPerDigest": 5,
  "trendMonitoring": true,
  "channels": ["discord"]  // where to send outbound
}
```
