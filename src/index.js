import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  enabled: true,
  mcpUrl: 'https://bosspig.moi/mcp',
  checkEveryMinutes: 15,
  cooldownMinutes: 720,
  maxItems: 3,
  quietHours: {
    enabled: false,
    start: '23:00',
    end: '08:00',
    timezone: 'America/Chicago',
  },
};

function mergeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    quietHours: { ...DEFAULTS.quietHours, ...(raw.quietHours || {}) },
  };
}

function severityFor(rescheduleCount = 0) {
  if (rescheduleCount >= 4) return 'intervention';
  if (rescheduleCount >= 2) return 'firm';
  return 'gentle';
}

function overdueBucket(minutes) {
  if (minutes >= 1440) return 'c';
  if (minutes >= 120) return 'b';
  return 'a';
}

function buildAlert(tasks, maxItems = 3) {
  const top = tasks.slice(0, maxItems);
  const lines = top.map((t) => `• ${t.title} — ${t.minutesOverdue}m overdue (rescheduled ${t.rescheduleCount}x)`);
  return [
    `⚠️ Boss Pig: ${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}`,
    ...lines,
  ].join('\n');
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, value) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function shouldAlertTask(task, prev, nowMs, cooldownMs) {
  if (!prev) return true;

  const elapsed = nowMs - (prev.lastAlertAt || 0);
  if (elapsed >= cooldownMs) return true;

  if ((task.rescheduleCount || 0) > (prev.lastRescheduleCount || 0)) return true;
  if (severityFor(task.rescheduleCount) !== prev.lastSeverity) return true;
  if (overdueBucket(task.minutesOverdue) !== prev.lastBucket) return true;

  return false;
}

async function fetchOverdue({ mcpUrl, apiKey }) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'list_overdue_todos',
      arguments: {},
    },
  };

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data?.result?.content?.[0]?.text;
  if (!text) return [];

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

async function runCheck(api, cfg, stateFile, opts = {}) {
  const nowMs = Date.now();
  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  const state = await loadJson(stateFile, { tasks: {}, lastAlert: null, lastError: null });

  const overdue = await fetchOverdue(cfg);
  if (!overdue.length) {
    return { overdueCount: 0, alerted: false, text: 'No overdue tasks.' };
  }

  overdue.sort((a, b) => (b.minutesOverdue || 0) - (a.minutesOverdue || 0));

  const toAlert = overdue.filter((task) =>
    shouldAlertTask(task, state.tasks?.[task.id], nowMs, cooldownMs),
  );

  if (!toAlert.length) {
    return {
      overdueCount: overdue.length,
      alerted: false,
      text: `Overdue tasks present (${overdue.length}) but all within cooldown.`,
    };
  }

  const alertText = buildAlert(overdue, cfg.maxItems);

  // Best-effort publish through runtime logger only (portable + safe).
  // Integrators can bridge this via Gateway methods/commands today.
  state.lastAlert = {
    at: nowMs,
    overdueCount: overdue.length,
    text: alertText,
  };

  for (const t of toAlert) {
    state.tasks[t.id] = {
      lastAlertAt: nowMs,
      lastMinutesOverdue: t.minutesOverdue || 0,
      lastRescheduleCount: t.rescheduleCount || 0,
      lastSeverity: severityFor(t.rescheduleCount || 0),
      lastBucket: overdueBucket(t.minutesOverdue || 0),
    };
  }

  await saveJson(stateFile, state);

  if (!opts.silent) {
    api.logger.info(`[boss-pig-plugin] ${alertText.replace(/\n/g, ' | ')}`);
  }

  return { overdueCount: overdue.length, alerted: true, text: alertText, toAlertCount: toAlert.length };
}

export default function register(api) {
  const cfg = mergeConfig(api?.entry?.config || {});
  const stateDir = api?.runtime?.state?.resolveStateDir
    ? api.runtime.state.resolveStateDir(api.config)
    : process.cwd();
  const stateFile = path.join(stateDir, 'boss-pig-plugin', 'overdue-alert-state.json');

  api.registerGatewayMethod('bosspig.status', async ({ respond }) => {
    const state = await loadJson(stateFile, { tasks: {}, lastAlert: null, lastError: null });
    respond(true, {
      ok: true,
      config: {
        enabled: cfg.enabled,
        mcpUrl: cfg.mcpUrl,
        checkEveryMinutes: cfg.checkEveryMinutes,
        cooldownMinutes: cfg.cooldownMinutes,
      },
      state,
    });
  });

  api.registerCommand({
    name: 'bosspig-check',
    description: 'Run Boss Pig overdue check now',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      try {
        const result = await runCheck(api, cfg, stateFile, { silent: true });
        return { text: result.text };
      } catch (err) {
        return { text: `Boss Pig check failed: ${err?.message || String(err)}` };
      }
    },
  });

  let timer = null;

  api.registerService({
    id: 'boss-pig-plugin.service',
    start: () => {
      if (!cfg.enabled) {
        api.logger.info('[boss-pig-plugin] disabled');
        return;
      }
      if (!cfg.apiKey) {
        api.logger.warn('[boss-pig-plugin] missing apiKey; service idle');
        return;
      }

      const tickMs = Math.max(60_000, Math.floor(cfg.checkEveryMinutes * 60_000));

      const tick = async () => {
        try {
          await runCheck(api, cfg, stateFile);
        } catch (err) {
          api.logger.warn(`[boss-pig-plugin] check failed: ${err?.message || String(err)}`);
        }
      };

      tick();
      timer = setInterval(tick, tickMs);
      api.logger.info(`[boss-pig-plugin] started (every ${Math.round(tickMs / 60000)}m)`);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      api.logger.info('[boss-pig-plugin] stopped');
    },
  });
}
