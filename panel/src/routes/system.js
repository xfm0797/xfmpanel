/**
 * 系统接口：概览数据聚合、健康检查、agent 信息。
 */

import { perm } from '../http/security.js';
import { callAgent, agentHealth } from '../services/agent.js';
import { siteStats } from '../services/sites.js';
import { certStats } from '../services/certs.js';
import { taskStats } from '../services/tasks.js';
import { openAlertCount } from '../services/alerts.js';
import { runtimeHealth } from '../services/runtimes.js';
import { metricsSnapshot } from '../services/metrics.js';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { PATHS } from '../../../shared/paths.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('system');

let infoCache = { at: 0, data: null };

export function registerSystemRoutes(app) {
  app.get('/api/v1/system/health', async (ctx) => {
    const agent = await agentHealth();
    return {
      panel: 'ok',
      agent,
      uptimeSec: Math.round(process.uptime()),
      db: dbCheck(),
      // 未登录也返回最小信息，便于探活；详细数据需要登录
      time: new Date().toISOString(),
    };
  });

  app.get('/api/v1/system/overview', perm('site:read'), async (ctx) => {
    const [agent, services] = await Promise.all([
      agentHealth(),
      runtimeHealth().catch((err) => {
        log.warn('运行时健康检查失败', { message: err.message });
        return [];
      }),
    ]);

    const info = await getSystemInfo();
    const tasks = getDb().all(
      `SELECT id, type, title, status, progress, error, created_at as createdAt
       FROM tasks ORDER BY created_at DESC LIMIT 8`,
    );

    return {
      panel: {
        version: config.version,
        env: config.env,
        hostname: config.hostname,
        uptimeSec: Math.round(process.uptime()),
        publicUrl: config.publicUrl,
        publicIpv4: config.publicIpv4,
        publicIpv6: config.publicIpv6,
        agentMode: config.agentMode,
        timezone: config.timezone,
      },
      system: info,
      agent,
      services,
      sites: siteStats(),
      certs: certStats(),
      tasks: { ...taskStats(), recent: tasks },
      alerts: { open: openAlertCount() },
      paths: PATHS,
    };
  });

  app.get('/api/v1/system/info', perm('site:read'), async () => getSystemInfo());

  /** 实时指标：CPU / 内存 / 磁盘 / 网络（含最近 15 分钟历史点） */
  app.get('/api/v1/system/metrics', perm('site:read'), async (ctx) => {
    const refresh = ctx.query?.refresh === '1';
    return metricsSnapshot({ refresh });
  });

  app.get('/api/v1/system/paths', perm('site:read'), async () => ({ paths: PATHS, config: {
    dbPath: config.dbPath,
    logDir: config.logDir,
    agentSocket: config.agentSocket,
    agentMode: config.agentMode,
  } }));
}

function dbCheck() {
  try {
    getDb().get('SELECT 1 as ok');
    return 'ok';
  } catch (err) {
    return `error: ${err.message}`;
  }
}

async function getSystemInfo() {
  if (infoCache.data && Date.now() - infoCache.at < 15000) return infoCache.data;
  try {
    const data = await callAgent('system.info', {}, { timeoutMs: 6000 });
    infoCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    return { unavailable: true, error: err.message };
  }
}
