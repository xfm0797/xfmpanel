#!/usr/bin/env node
/**
 * XFMPanel 面板进程入口。
 *
 * 进程职责：HTTP 服务 + 业务编排 + 任务队列 + 定时巡检。
 * 该进程以非 root 用户（xfmpanel）运行，任何需要 root 的动作都通过 agent 执行。
 */

import fs from 'node:fs';
import { config, ensureRuntimeDirs } from './config.js';
import { openDatabase } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { createApp, startServer } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import { middlewares } from './http/security.js';
import { registerRoutes } from './routes/index.js';
import { startWorker, stopWorker, cleanupOldTasks } from './services/tasks.js';
import { startMetricsSampler, stopMetricsSampler } from './services/metrics.js';
import { refreshCertificateStatuses, scheduleRenewals, cleanupCertChecks } from './services/certs.js';
import { cleanupExpiredSessions } from './services/sessions.js';
import { cleanupAuditLogs } from './services/audit.js';
import { agentHealth } from './services/agent.js';

const log = createLogger('server');

let shuttingDown = false;

async function main() {
  ensureRuntimeDirs(fs);
  openDatabase({ verbose: config.isDev });
  const seed = seedDatabase();

  const { app, handle } = createApp();
  for (const mw of middlewares()) app.use(mw);
  registerRoutes(app);

  const server = await startServer({ app, handle });

  startWorker();
  startSchedulers();
  startMetricsSampler();

  const health = await agentHealth();
  if (!health.ok) {
    log.warn(`agent 当前不可用：${health.error}（站点/环境操作会失败，请检查 xfmpanel-agent）`);
  } else {
    log.info(`agent 就绪（mode=${health.mode}, ${health.latencyMs}ms）`);
  }

  const url = config.publicUrl || `http://${config.bind}:${config.port}`;
  log.info(`XFMPanel ${config.version} 已启动 → ${url}（env=${config.env}）`);
  if (seed.created) {
    log.warn(`初始管理员：${seed.username}${seed.generated ? '（密码见 data/initial-admin.txt）' : ''}`);
  }

  const stop = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，开始优雅退出`);
    stopWorker();
    stopMetricsSampler();
    clearSchedulers();
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
    try { openDatabase().close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 300).unref?.();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

let timers = [];

function startSchedulers() {
  const runCertScan = async (tag) => {
    try {
      const refreshed = refreshCertificateStatuses();
      const scheduled = scheduleRenewals();
      if (refreshed.changed || scheduled.queued.length) {
        log.info(`证书巡检(${tag})：状态变更 ${refreshed.changed}，续期入队 ${scheduled.queued.length}`);
      }
    } catch (err) {
      log.error('证书巡检失败', { message: err.message, stack: err.stack });
    }
  };

  // 启动后 30 秒做首次巡检，避免与启动争抢资源
  timers.push(setTimeout(() => runCertScan('startup'), 30_000).unref?.() ?? null);
  timers.push(setInterval(() => runCertScan('periodic'), config.certCheckIntervalMs));

  timers.push(setInterval(() => {
    try {
      const sessions = cleanupExpiredSessions();
      const tasks = cleanupOldTasks();
      const checks = cleanupCertChecks();
      const audits = cleanupAuditLogs();
      if (sessions || tasks || checks || audits) {
        log.info(`清理：会话 ${sessions}，历史任务 ${tasks}，证书巡检 ${checks}，审计日志 ${audits}`);
      }
    } catch (err) {
      log.warn('清理任务失败', { message: err.message });
    }
  }, 12 * 3600 * 1000));

  timers = timers.filter(Boolean);
}

function clearSchedulers() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

process.on('uncaughtException', (err) => {
  log.error('未捕获异常', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { message: reason?.message || String(reason), stack: reason?.stack });
});

main().catch(async (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，请修改 XFMP_PORT 或停止占用进程`);
  } else {
    console.error('启动失败：', err);
  }
  log.error('启动失败', { message: err.message, stack: err.stack });
  process.exit(1);
});
