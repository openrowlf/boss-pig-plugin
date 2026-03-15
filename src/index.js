import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  enabled: true,
  agentId: 'bosspig',
  delivery: null,
  mcpUrl: 'https://bosspig.moi/mcp',
  checkEveryMinutes: 15,
  cooldownMinutes: 720,
  maxItems: 3,
  manualCommandEnabled: false,
  backlogNudgeEnabled: true,
  backlogMaxItems: 3,
};

export function mergeConfig(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    delivery: raw.delivery ? { ...raw.delivery } : DEFAULTS.delivery,
    quietHours: { ...DEFAULTS.quietHours, ...(raw.quietHours || {}) },
  };
}

export function resolveEffectiveConfig(baseCfg, globalCfg = null) {
  const globalPluginCfg = globalCfg?.plugins?.entries?.['boss-pig']?.config || {};
  const skill = globalCfg?.skills?.entries?.['boss-pig'] || null;

  const cfg = mergeConfig({ ...(baseCfg || {}), ...(globalPluginCfg || {}) });

  if (skill?.apiKey) {
    cfg.apiKey = skill.apiKey;
    cfg.__apiKeySource = 'skills.entries.boss-pig.apiKey';
  } else if (cfg.apiKey) {
    cfg.__apiKeySource = 'plugins.entries.boss-pig.config.apiKey';
  } else {
    cfg.__apiKeySource = null;
  }

  if (skill?.env?.BOSS_PIG_MCP_URL) {
    cfg.mcpUrl = skill.env.BOSS_PIG_MCP_URL;
    cfg.__mcpUrlSource = 'skills.entries.boss-pig.env.BOSS_PIG_MCP_URL';
  } else {
    cfg.__mcpUrlSource = 'plugins.entries.boss-pig.config.mcpUrl';
  }

  return cfg;
}

function isWithinActiveHours(globalCfg) {
  const agent = (globalCfg?.agents?.list || []).find(a => a.id === 'bosspig');
  const activeHours = agent?.heartbeat?.activeHours;
  if (!activeHours) return true; // no restriction

  const tz = activeHours.timezone || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = formatter.format(new Date()).split(':').map(Number);
  const currentMinutes = hh * 60 + mm;
  const [startH, startM] = (activeHours.start || '00:00').split(':').map(Number);
  const [endH, endM] = (activeHours.end || '23:59').split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function severityFor(rescheduleCount = 0) {
  if (rescheduleCount >= 4) return 'intervention';
  if (rescheduleCount >= 2) return 'firm';
  return 'gentle';
}

export function overdueBucket(minutes) {
  if (minutes >= 1440) return 'c';
  if (minutes >= 120) return 'b';
  return 'a';
}

export function buildAlert(tasks, maxItems = 3) {
  const top = tasks.slice(0, maxItems);
  const lines = top.map((t) => `• ${t.title} — ${t.minutesOverdue}m overdue (rescheduled ${t.rescheduleCount}x)`);
  return [
    `⚠️ Boss Pig: ${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}`,
    ...lines,
  ].join('\n');
}

function buildHybridPayload(overdue, cfg) {
  return {
    type: 'boss_pig.overdue_alert',
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      totalOverdue: overdue.length,
      topCount: Math.min(cfg.maxItems, overdue.length),
    },
    tasks: overdue.slice(0, cfg.maxItems).map((t) => ({
      id: t.id,
      title: t.title,
      minutesOverdue: t.minutesOverdue || 0,
      rescheduleCount: t.rescheduleCount || 0,
      severity: severityFor(t.rescheduleCount || 0),
    })),
    policy: {
      cooldownMinutes: cfg.cooldownMinutes,
      checkEveryMinutes: cfg.checkEveryMinutes,
    },
  };
}

function buildSystemEventText(payload) {
  return [
    'BOSS_PIG_PLUGIN_ALERT',
    JSON.stringify(payload),
    'Compose a concise, persona-aligned user message from this payload and send it to the configured chat target.',
  ].join('\n\n');
}

function localDateKey(timeZone = 'UTC') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

async function sendFallbackMessage(api, cfg, text) {
  const ch = String(cfg?.delivery?.channel || '').toLowerCase();
  const to = String(cfg?.delivery?.to || '').trim();
  if (!ch || !to) return false;

  try {
    if (ch === 'telegram') {
      await api.runtime.channel.telegram.sendMessageTelegram(to, text, cfg.delivery.accountId ? { accountId: cfg.delivery.accountId } : {});
      return true;
    }
    if (ch === 'discord') {
      const target = to.startsWith('channel:') || to.startsWith('user:') ? to : `channel:${to}`;
      await api.runtime.channel.discord.sendMessageDiscord(target, text, cfg.delivery.accountId ? { accountId: cfg.delivery.accountId } : {});
      return true;
    }
  } catch (err) {
    api.logger.warn(`[boss-pig-plugin] fallback send failed: ${err?.message || String(err)}`);
  }

  return false;
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function saveJson(filePath, value) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

export function shouldAlertTask(task, prev, nowMs, cooldownMs) {
  if (!prev) return true;

  const currentReschedules = Number(task?.rescheduleCount || 0);
  const previousReschedules = Number(prev?.lastRescheduleCount || 0);

  // A reschedule-count increase indicates a new overdue cycle.
  // Allow immediate alert instead of waiting for prior cooldown.
  if (currentReschedules > previousReschedules) return true;

  const lastAlertAt = Number(prev.lastAlertAt || 0);
  if (!lastAlertAt) return true;

  // Re-alert only after the per-task cooldown expires.
  // This gives a steady "do or reschedule" nudge cadence without spamming.
  return (nowMs - lastAlertAt) >= cooldownMs;
}

export async function callMcpTool({ mcpUrl, apiKey }, name, args = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args || {},
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
  if (data?.error) {
    const code = data.error?.code;
    const message = data.error?.message || 'Unknown MCP error';
    throw new Error(`MCP error ${code ?? 'unknown'}: ${message}`);
  }
  return data?.result?.content ?? [];
}

export async function fetchOverdue({ mcpUrl, apiKey }) {
  const content = await callMcpTool({ mcpUrl, apiKey }, 'list_overdue_todos', {});
  const text = content?.[0]?.text;
  if (!text) return [];

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

export async function fetchBacklog({ mcpUrl, apiKey }) {
  const content = await callMcpTool({ mcpUrl, apiKey }, 'list_todos', { status: 'backlog' });
  const text = content?.[0]?.text;
  if (!text) return [];

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

export async function runCheck(api, cfg, stateFile, opts = {}) {
  const nowMs = Date.now();
  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  const state = await loadJson(stateFile, { tasks: {}, lastAlert: null, lastError: null, backlog: { lastNudgeDate: null } });

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

  // Only include tasks that triggered the alert (toAlert), not all overdue tasks.
  const alertText = buildAlert(toAlert, cfg.maxItems);
  const payload = buildHybridPayload(toAlert, cfg);

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

  return { overdueCount: overdue.length, alerted: true, text: alertText, toAlertCount: toAlert.length, payload };
}

export async function runBacklogCheck(api, cfg, stateFile, opts = {}) {
  const state = await loadJson(stateFile, { tasks: {}, lastAlert: null, lastError: null, backlog: { lastNudgeDate: null } });
  const backlog = await fetchBacklog(cfg);
  if (!backlog.length) return { backlogCount: 0, alerted: false, text: 'No backlog tasks.' };

  const dateKey = opts.dateKey || localDateKey(opts.timeZone || 'UTC');
  if ((state.backlog?.lastNudgeDate || null) === dateKey) {
    return { backlogCount: backlog.length, alerted: false, text: `Backlog present (${backlog.length}) but already nudged today.` };
  }

  const top = backlog.slice(0, Math.max(1, Number(cfg.backlogMaxItems || 3))).map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority || 3,
  }));

  const payload = {
    type: 'boss_pig.backlog_nudge',
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      totalBacklog: backlog.length,
      topCount: top.length,
    },
    tasks: top,
    policy: {
      oncePerDay: true,
      dateKey,
    },
  };

  const lines = top.map((t) => `• ${t.title}`);
  const text = [`🗂️ Boss Pig: ${backlog.length} backlog task${backlog.length === 1 ? '' : 's'}`, ...lines].join('\n');

  state.backlog = {
    lastNudgeDate: dateKey,
    lastNudgeAt: Date.now(),
    lastCount: backlog.length,
  };
  await saveJson(stateFile, state);

  return { backlogCount: backlog.length, alerted: true, text, payload };
}

export default function register(api) {
  const baseCfg = mergeConfig(api?.entry?.config || {});
  const loadGlobalConfig = () => {
    try {
      if (api?.runtime?.config?.loadConfig) return api.runtime.config.loadConfig();
    } catch {
      // fall through
    }

    try {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (!home) return null;
      const raw = fsSync.readFileSync(path.join(home, '.openclaw', 'openclaw.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const getCfg = () => resolveEffectiveConfig(baseCfg, loadGlobalConfig() || api?.config || null);

  const stateDir = api?.runtime?.state?.resolveStateDir
    ? api.runtime.state.resolveStateDir(api.config)
    : process.cwd();
  const stateFile = path.join(stateDir, 'boss-pig-plugin', 'overdue-alert-state.json');

  const bossPigTools = [
    'list_todos',
    'list_scheduled_todos',
    'list_overdue_todos',
    'list_categories',
    'create_category',
    'update_category',
    'add_todo',
    'update_todo',
    'schedule_todo',
    'reschedule_todo',
    'find_open_slots',
    'list_selected_calendars',
    'get_upcoming_events',
    'get_schedule_summary',
  ];

  for (const toolName of bossPigTools) {
    api.registerTool({
      name: `boss_pig_${toolName}`,
      description: `Boss Pig MCP: ${toolName}`,
      parameters: {
        type: 'object',
        properties: {
          arguments: {
            type: 'object',
            description: `Arguments for Boss Pig MCP tool \"${toolName}\"`,
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const cfg = getCfg();
        if (!cfg?.apiKey) throw new Error('Boss Pig API key is missing (skills.entries.boss-pig.apiKey)');
        if (!cfg?.mcpUrl) throw new Error('Boss Pig MCP URL is missing (skills.entries.boss-pig.env.BOSS_PIG_MCP_URL)');

        const passedArgs = (params && typeof params.arguments === 'object' && params.arguments)
          ? params.arguments
          : (params || {});

        const content = await callMcpTool(cfg, toolName, passedArgs);
        if (Array.isArray(content) && content.length) return { content };
        return { content: [{ type: 'text', text: 'OK' }] };
      },
    });
  }

  api.registerGatewayMethod('bosspig.status', async ({ respond }) => {
    const cfg = getCfg();
    const state = await loadJson(stateFile, { tasks: {}, lastAlert: null, lastError: null });
    respond(true, {
      ok: true,
      config: {
        enabled: cfg.enabled,
        agentId: cfg.agentId,
        delivery: cfg.delivery,
        mcpUrl: cfg.mcpUrl,
        checkEveryMinutes: cfg.checkEveryMinutes,
        cooldownMinutes: cfg.cooldownMinutes,
        apiKeySource: cfg.__apiKeySource || null,
      },
      state,
    });
  });

  if (baseCfg.manualCommandEnabled) {
    api.registerCommand({
      name: 'bosspig-check',
      description: 'Run Boss Pig overdue check now',
      acceptsArgs: false,
      requireAuth: true,
      handler: async () => {
        try {
          const cfg = getCfg();
          const result = await runCheck(api, cfg, stateFile, { silent: true });
          return { text: result.text };
        } catch (err) {
          return { text: `Boss Pig check failed: ${err?.message || String(err)}` };
        }
      },
    });
  }

  let timer = null;

  api.registerService({
    id: 'boss-pig-plugin.service',
    start: () => {
      const cfg = getCfg();

      api.logger.info(`[boss-pig-plugin] startup cfg: enabled=${!!cfg.enabled} hasApiKey=${!!cfg.apiKey} hasAgentId=${!!cfg.agentId} hasDelivery=${!!(cfg.delivery && cfg.delivery.channel && cfg.delivery.to)} apiKeySource=${cfg.__apiKeySource || 'none'}`);

      if (!cfg.enabled) {
        api.logger.info('[boss-pig-plugin] disabled');
        return;
      }
      if (!cfg.apiKey) {
        api.logger.warn('[boss-pig-plugin] missing apiKey in skills.entries.boss-pig.apiKey; service idle');
        return;
      }
      if (!cfg.agentId) {
        api.logger.warn('[boss-pig-plugin] missing config.agentId; service idle');
        return;
      }
      const tickMs = Math.max(60_000, Math.floor(cfg.checkEveryMinutes * 60_000));

      const tick = async () => {
        try {
          const latestCfg = getCfg();

          const globalCfg = loadGlobalConfig();
          const agent = (globalCfg?.agents?.list || []).find(a => a.id === 'bosspig');
          api.logger.info(`[boss-pig-plugin] activeHours config: ${JSON.stringify(agent?.heartbeat?.activeHours)}`);
          const withinActive = isWithinActiveHours(globalCfg);
          api.logger.info(`[boss-pig-plugin] isWithinActiveHours: ${withinActive}`);
          if (!withinActive) {
            api.logger.info('[boss-pig-plugin] skipped enqueueing outside active hours');
            return;
          }

          const deliverPayload = async (payload, reason, fallbackText) => {
            const eventText = buildSystemEventText(payload);
            let delivered = false;

            if (latestCfg.agentId) {
              try {
                const mainKey = `agent:${latestCfg.agentId}:main`;
                api.runtime.system.enqueueSystemEvent(eventText, {
                  sessionKey: mainKey,
                  contextKey: 'boss-pig-plugin',
                });
                api.runtime.system.requestHeartbeatNow({
                  reason,
                  agentId: latestCfg.agentId,
                  sessionKey: mainKey,
                });
                delivered = true;
                api.logger.info(`[boss-pig-plugin] system event enqueued for agent ${latestCfg.agentId}`);
              } catch (err) {
                api.logger.warn(`[boss-pig-plugin] system-event bridge failed: ${err?.message || String(err)}`);
              }
            }

            if (!delivered) {
              const sent = await sendFallbackMessage(api, latestCfg, fallbackText);
              if (sent) {
                api.logger.info(`[boss-pig-plugin] fallback message sent to ${latestCfg.delivery.channel}:${latestCfg.delivery.to}`);
              }
            }
          };

          const overdue = await runCheck(api, latestCfg, stateFile);
          if (overdue?.alerted) {
            await deliverPayload(overdue.payload, 'boss-pig-plugin-alert', overdue.text);
            return; // avoid stacking backlog nudge on same tick as overdue alert
          }

          if (latestCfg.backlogNudgeEnabled !== false) {
            const tz = agent?.heartbeat?.activeHours?.timezone || 'America/Chicago';
            const backlog = await runBacklogCheck(api, latestCfg, stateFile, { timeZone: tz, dateKey: localDateKey(tz) });
            if (backlog?.alerted) {
              await deliverPayload(backlog.payload, 'boss-pig-plugin-backlog', backlog.text);
            }
          }
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
