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
  const cfg = mergeConfig({ ...(baseCfg || {}), ...(globalPluginCfg || {}) });
  const skill = globalCfg?.skills?.entries?.['boss-pig'] || null;

  if (!cfg.apiKey && skill?.apiKey) {
    cfg.apiKey = skill.apiKey;
    cfg.__apiKeySource = 'skills.entries.boss-pig.apiKey';
  } else if (cfg.apiKey) {
    cfg.__apiKeySource = 'plugins.entries.boss-pig.config.apiKey';
  }

  if (!cfg.mcpUrl && skill?.env?.BOSS_PIG_MCP_URL) {
    cfg.mcpUrl = skill.env.BOSS_PIG_MCP_URL;
    cfg.__mcpUrlSource = 'skills.entries.boss-pig.env.BOSS_PIG_MCP_URL';
  } else {
    cfg.__mcpUrlSource = 'plugins.entries.boss-pig.config.mcpUrl';
  }

  const pluginKey = String(baseCfg?.apiKey || '').trim();
  const skillKey = String(skill?.apiKey || '').trim();
  cfg.__keyDrift = {
    pluginPresent: !!pluginKey,
    skillPresent: !!skillKey,
    mismatch: !!pluginKey && !!skillKey && pluginKey !== skillKey,
  };

  return cfg;
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

  // Alert triggers: reschedule change only. No bucket trigger.
  if ((task.rescheduleCount || 0) > (prev.lastRescheduleCount || 0)) return true;

  return false;
}

export async function fetchOverdue({ mcpUrl, apiKey }) {
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

export async function runCheck(api, cfg, stateFile, opts = {}) {
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
        keyDrift: cfg.__keyDrift,
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
      if (cfg.__keyDrift?.mismatch) {
        api.logger.warn('[boss-pig-plugin] apiKey mismatch between plugin config and skills.entries.boss-pig.apiKey');
      } else if (cfg.__keyDrift?.pluginPresent && !cfg.__keyDrift?.skillPresent) {
        api.logger.warn('[boss-pig-plugin] plugin apiKey is set but skills.entries.boss-pig.apiKey is empty (subagent skill calls may fail)');
      }
      if (!cfg.apiKey) {
        api.logger.warn('[boss-pig-plugin] missing apiKey (plugin config or skills fallback); service idle');
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

          const result = await runCheck(api, latestCfg, stateFile);
          if (!result?.alerted) return;

          // Hybrid delivery: enqueue system event to trigger Piggy, fallback to direct message if that fails.
          const eventText = buildSystemEventText(result.payload);
          let delivered = false;

          // Try to enqueue system event for Piggy to pick up via heartbeat
          if (latestCfg.agentId) {
            try {
              // Enqueue to main session - heartbeat will wake Piggy with this context
              const mainKey = `agent:${latestCfg.agentId}:main`;
              api.runtime.system.enqueueSystemEvent(eventText, {
                sessionKey: mainKey,
                contextKey: 'boss-pig-plugin',
              });
              // Request immediate heartbeat to process the event
              api.runtime.system.requestHeartbeatNow({
                reason: 'boss-pig-plugin-alert',
                agentId: latestCfg.agentId,
                sessionKey: mainKey,
              });
              delivered = true;
              api.logger.info(`[boss-pig-plugin] system event enqueued for agent ${latestCfg.agentId}`);
            } catch (err) {
              api.logger.warn(`[boss-pig-plugin] system-event bridge failed: ${err?.message || String(err)}`);
            }
          }

          // Fallback: direct channel message if system event didn't work
          if (!delivered) {
            const sent = await sendFallbackMessage(api, latestCfg, result.text);
            if (sent) {
              api.logger.info(`[boss-pig-plugin] fallback message sent to ${latestCfg.delivery.channel}:${latestCfg.delivery.to}`);
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
