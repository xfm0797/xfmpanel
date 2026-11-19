/**
 * 运行配置。
 *
 * 生产环境由 systemd EnvironmentFile=/etc/xfmpanel/panel.env 注入；
 * 本地开发（win32 或 XFMP_ENV=dev）自动降级为仓库内 ./data 目录 + stub agent。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../shared/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// 版本号只维护在 package.json，避免面板显示与实际发布版本脱节
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const isDev =
  process.env.XFMP_ENV === 'dev' ||
  process.env.NODE_ENV === 'development' ||
  process.platform === 'win32';

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function bool(key, fallback = false) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

const devDataDir = path.join(REPO_ROOT, 'data');

export const config = Object.freeze({
  env: isDev ? 'dev' : 'prod',
  isDev,

  // HTTP
  bind: env('XFMP_BIND', '127.0.0.1'),
  port: int('XFMP_PORT', 8787),
  publicUrl: env('XFMP_PUBLIC_URL', ''),
  // 安装脚本探测到的公网地址（IPv6 不带方括号），用于登录页/概览展示
  publicIpv4: env('XFMP_PUBLIC_IPV4', ''),
  publicIpv6: env('XFMP_PUBLIC_IPV6', ''),
  // 默认不信任 X-Forwarded-For：直连部署下伪造该头可绕过限流/污染审计 IP。
  // 仅在明确部署在可信反代之后时通过 XFMP_TRUST_PROXY=1 显式开启。
  trustProxy: bool('XFMP_TRUST_PROXY', false),
  cookieSecure: env('XFMP_COOKIE_SECURE', 'auto'), // auto | 1 | 0
  sessionTtlHours: int('XFMP_SESSION_TTL_HOURS', 12),
  bodyLimitBytes: int('XFMP_BODY_LIMIT', 1024 * 1024),

  // 数据与日志
  dataDir: env('XFMP_DATA_DIR', isDev ? devDataDir : PATHS.PANEL_STATE_DIR),
  dbPath: env('XFMP_DB', isDev ? path.join(devDataDir, 'xfmpanel.db') : `${PATHS.PANEL_STATE_DIR}/xfmpanel.db`),
  logDir: env('XFMP_LOG_DIR', isDev ? path.join(devDataDir, 'logs') : PATHS.PANEL_LOG_DIR),
  webDir: path.join(REPO_ROOT, 'panel', 'web'),

  // agent
  agentMode: env('XFMP_AGENT_MODE', isDev ? 'stub' : 'unix'), // unix | stub
  agentSocket: env('XFMP_AGENT_SOCKET', isDev ? path.join(devDataDir, 'agent.sock') : PATHS.AGENT_SOCKET),
  agentSecretFile: env('XFMP_AGENT_SECRET_FILE', isDev ? path.join(devDataDir, 'agent.secret') : PATHS.AGENT_SECRET),
  agentTimeoutMs: int('XFMP_AGENT_TIMEOUT_MS', 15 * 60 * 1000),
  agentSecret: env('XFMP_AGENT_SECRET', ''),

  // 安全
  bootstrapAdminPassword: env('XFMP_ADMIN_PASSWORD', ''),
  loginMaxAttempts: int('XFMP_LOGIN_MAX_ATTEMPTS', 5),
  loginLockMinutes: int('XFMP_LOGIN_LOCK_MINUTES', 15),
  rateLimitPerMinute: int('XFMP_RATE_LIMIT', 240),

  // 任务
  taskConcurrency: int('XFMP_TASK_CONCURRENCY', 2),
  taskPollMs: int('XFMP_TASK_POLL_MS', 1000),
  taskRetentionDays: int('XFMP_TASK_RETENTION_DAYS', 30),
  backupRetentionDays: int('XFMP_BACKUP_RETENTION_DAYS', 30),
  certCheckRetentionDays: int('XFMP_CERT_CHECK_RETENTION_DAYS', 90),
  auditRetentionDays: int('XFMP_AUDIT_RETENTION_DAYS', 180),

  // 证书巡检
  certCheckIntervalMs: int('XFMP_CERT_CHECK_INTERVAL_MS', 6 * 60 * 60 * 1000),
  certRenewBeforeDays: int('XFMP_CERT_RENEW_DAYS', 30),
  certExpiringWarnDays: int('XFMP_CERT_WARN_DAYS', 15),

  hostname: os.hostname(),
  timezone: env('XFMP_TZ', 'Asia/Shanghai'),
  version: PKG_VERSION,
});

export function isHttpsRequest(req) {
  if (config.cookieSecure === '1') return true;
  if (config.cookieSecure === '0') return false;
  return (
    req?.headers?.['x-forwarded-proto'] === 'https' ||
    Boolean(req?.socket?.encrypted)
  );
}

/** 启动前的目录准备 */
export function ensureRuntimeDirs(fs) {
  for (const dir of [config.dataDir, config.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
