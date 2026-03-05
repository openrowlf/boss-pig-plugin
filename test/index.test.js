import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  mergeConfig,
  severityFor,
  overdueBucket,
  buildAlert,
  shouldAlertTask,
  fetchOverdue,
  runCheck,
  loadJson,
} from '../src/index.js';

describe('boss-pig-plugin helpers', () => {
  it('mergeConfig applies defaults and overrides', () => {
    const cfg = mergeConfig({ checkEveryMinutes: 5, quietHours: { enabled: true } });
    expect(cfg.checkEveryMinutes).toBe(5);
    expect(cfg.cooldownMinutes).toBe(720);
    expect(cfg.quietHours.enabled).toBe(true);
    expect(cfg.quietHours.start).toBe('23:00');
  });

  it('severityFor maps counts correctly', () => {
    expect(severityFor(0)).toBe('gentle');
    expect(severityFor(2)).toBe('firm');
    expect(severityFor(4)).toBe('intervention');
  });

  it('overdueBucket maps minutes correctly', () => {
    expect(overdueBucket(10)).toBe('a');
    expect(overdueBucket(200)).toBe('b');
    expect(overdueBucket(2000)).toBe('c');
  });

  it('buildAlert includes total and top items', () => {
    const text = buildAlert([
      { title: 'A', minutesOverdue: 10, rescheduleCount: 0 },
      { title: 'B', minutesOverdue: 20, rescheduleCount: 2 },
    ]);
    expect(text).toContain('2 overdue tasks');
    expect(text).toContain('A');
    expect(text).toContain('B');
  });

  it('shouldAlertTask respects cooldown and escalation', () => {
    const now = Date.now();
    const prev = {
      lastAlertAt: now - 5 * 60 * 1000,
      lastRescheduleCount: 1,
      lastSeverity: 'gentle',
      lastBucket: 'a',
    };

    expect(shouldAlertTask({ minutesOverdue: 30, rescheduleCount: 1 }, prev, now, 10 * 60 * 1000)).toBe(false);
    expect(shouldAlertTask({ minutesOverdue: 130, rescheduleCount: 1 }, prev, now, 10 * 60 * 1000)).toBe(true); // bucket jump
    expect(shouldAlertTask({ minutesOverdue: 30, rescheduleCount: 2 }, prev, now, 10 * 60 * 1000)).toBe(true); // severity/reschedule change
  });
});

describe('boss-pig-plugin network + state', () => {
  const originalFetch = global.fetch;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boss-pig-plugin-test-'));
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fetchOverdue parses MCP result', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          content: [{ type: 'text', text: JSON.stringify([{ id: '1', title: 'Task', minutesOverdue: 33, rescheduleCount: 0 }]) }],
        },
      }),
    }));

    const rows = await fetchOverdue({ mcpUrl: 'http://x/mcp', apiKey: 'bp_x' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Task');
  });

  it('runCheck writes state and alerts when overdue exists', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          content: [{ type: 'text', text: JSON.stringify([{ id: '1', title: 'Task', minutesOverdue: 150, rescheduleCount: 2 }]) }],
        },
      }),
    }));

    const api = { logger: { info: vi.fn(), warn: vi.fn() } };
    const stateFile = path.join(tmpDir, 'state.json');
    const cfg = mergeConfig({ apiKey: 'bp_x', mcpUrl: 'http://x/mcp', cooldownMinutes: 720 });

    const res = await runCheck(api, cfg, stateFile, { silent: true });
    expect(res.alerted).toBe(true);
    expect(res.overdueCount).toBe(1);

    const saved = await loadJson(stateFile, null);
    expect(saved.tasks['1']).toBeTruthy();
    expect(saved.tasks['1'].lastSeverity).toBe('firm');
  });
});
