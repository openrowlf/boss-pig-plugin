import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  mergeConfig,
  resolveEffectiveConfig,
  severityFor,
  overdueBucket,
  buildAlert,
  shouldAlertTask,
  fetchOverdue,
  runCheck,
  loadJson,
  callMcpTool,
} from '../src/index.js';

describe('boss-pig-plugin helpers', () => {
  it('mergeConfig applies defaults and overrides', () => {
    const cfg = mergeConfig({ checkEveryMinutes: 5 });
    expect(cfg.checkEveryMinutes).toBe(5);
    expect(cfg.cooldownMinutes).toBe(720);
  });

  it('resolveEffectiveConfig prefers skill config as canonical source', () => {
    const cfg = resolveEffectiveConfig(
      { apiKey: 'bp_plugin', mcpUrl: 'https://bosspig.moi/mcp' },
      { skills: { entries: { 'boss-pig': { apiKey: 'bp_skill', env: { BOSS_PIG_MCP_URL: 'http://localhost:8787/mcp' } } } } },
    );

    expect(cfg.apiKey).toBe('bp_skill');
    expect(cfg.mcpUrl).toBe('http://localhost:8787/mcp');
    expect(cfg.__apiKeySource).toBe('skills.entries.boss-pig.apiKey');
    expect(cfg.__mcpUrlSource).toBe('skills.entries.boss-pig.env.BOSS_PIG_MCP_URL');
  });

  it('resolveEffectiveConfig falls back to plugin config when skill config is absent', () => {
    const cfg = resolveEffectiveConfig(
      { apiKey: 'bp_plugin', mcpUrl: 'https://bosspig.moi/mcp' },
      {},
    );

    expect(cfg.apiKey).toBe('bp_plugin');
    expect(cfg.mcpUrl).toBe('https://bosspig.moi/mcp');
    expect(cfg.__apiKeySource).toBe('plugins.entries.boss-pig.config.apiKey');
    expect(cfg.__mcpUrlSource).toBe('plugins.entries.boss-pig.config.mcpUrl');
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

  it('shouldAlertTask re-alerts immediately on reschedule increase, else uses cooldown', () => {
    const now = Date.now();
    const prev = {
      lastAlertAt: now - 5 * 60 * 1000,
      lastRescheduleCount: 1,
      lastSeverity: 'gentle',
      lastBucket: 'a',
    };

    // Inside cooldown: no repeat alert yet when unchanged.
    expect(shouldAlertTask({ minutesOverdue: 130, rescheduleCount: 1 }, prev, now, 10 * 60 * 1000)).toBe(false);
    // Reschedule increased: alert immediately, even inside cooldown.
    expect(shouldAlertTask({ minutesOverdue: 10, rescheduleCount: 2 }, prev, now, 10 * 60 * 1000)).toBe(true);
    // After cooldown: alert again even if reschedule count did not change.
    expect(shouldAlertTask({ minutesOverdue: 130, rescheduleCount: 1 }, prev, now, 2 * 60 * 1000)).toBe(true);
    // Missing prior state should always alert.
    expect(shouldAlertTask({ minutesOverdue: 30, rescheduleCount: 2 }, null, now, 10 * 60 * 1000)).toBe(true);
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

  it('callMcpTool throws on JSON-RPC error payloads', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        error: { code: 400, message: 'id, startIso, endIso required' },
      }),
    }));

    await expect(callMcpTool({ mcpUrl: 'http://x/mcp', apiKey: 'bp_x' }, 'reschedule_todo', {}))
      .rejects.toThrow('MCP error 400: id, startIso, endIso required');
  });
});
