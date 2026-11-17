/**
 * 全局安全中间件：会话装载 / 限流 / CSRF / 审计落盘。
 *
 * 顺序很重要：先鉴权（拿到 ctx.user）→ 限流 → CSRF → 业务。
 */

import { findSession, touchSession, SESSION_COOKIE, revokeSession } from '../services/sessions.js';
import { getUserById, hasPermission } from '../services/users.js';
import { errors, HttpError } from '../lib/errors.js';
import { flushContextAudit } from '../services/audit.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('security');

/** 会话装载：无效会话按匿名处理，由具体路由决定是否要求登录 */
export async function sessionLoader(ctx) {
  const token = ctx.cookies[SESSION_COOKIE];
  if (!token) return;
  const session = findSession(token);
  if (!session) {
    ctx.clearCookie(SESSION_COOKIE);
    return;
  }
  const user = getUserById(session.user_id);
  if (!user || user.status !== 'active') {
    revokeSession(token);
    ctx.clearCookie(SESSION_COOKIE);
    return;
  }
  ctx.session = session;
  ctx.user = user;
  touchSession(session);
}

const buckets = new Map();

/** 粗粒度限流：按 IP 每分钟 N 次，防暴力遍历；登录另有更严格的节流 */
export async function rateLimit(ctx) {
  if (!ctx.pathname.startsWith('/api/')) return;
  const now = Date.now();
  const key = ctx.ip || 'unknown';
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > config.rateLimitPerMinute) {
    ctx.res.setHeader('Retry-After', '60');
    throw new HttpError('RATE_LIMITED');
  }
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = new Set(['/api/v1/auth/login']);

function sameOrigin(ctx) {
  const origin = ctx.headers.origin || ctx.headers.referer;
  if (!origin) return true; // 非浏览器客户端（curl / 脚本）由令牌本身防护
  try {
    const host = new URL(origin).host;
    return host === ctx.headers.host;
  } catch {
    return false;
  }
}

/** CSRF：双提交校验 + Origin 校验（SameSite=Lax 作为最后一道） */
export async function csrfGuard(ctx) {
  if (!ctx.pathname.startsWith('/api/')) return;
  if (SAFE_METHODS.has(ctx.method)) return;

  if (!sameOrigin(ctx)) {
    throw new HttpError('CSRF_INVALID', { message: '请求来源不合法' });
  }
  if (CSRF_EXEMPT.has(ctx.pathname)) return;

  if (!ctx.session) throw errors.authRequired();
  const token = ctx.headers['x-csrf-token'];
  if (!token || token !== ctx.session.csrf_token) {
    throw new HttpError('CSRF_INVALID');
  }
}

/** 审计落盘：在响应后统一写入，避免业务代码到处散落 */
export async function auditFlusher(ctx) {
  ctx.res.on('finish', () => {
    try {
      flushContextAudit(ctx);
    } catch (err) {
      log.error('审计落盘异常', { message: err.message });
    }
  });
}

/** 路由级权限守卫：app.get('/x', perm('site:write'), handler) */
export function perm(permission) {
  return async function permissionGuard(ctx) {
    if (!ctx.user) throw errors.authRequired();
    if (!hasPermission(ctx.user, permission)) {
      throw new HttpError('FORBIDDEN', { message: `需要权限：${permission}` });
    }
    return undefined;
  };
}

export function requireLogin() {
  return async function loginGuard(ctx) {
    if (!ctx.user) throw errors.authRequired();
    return undefined;
  };
}

export function middlewares() {
  return [sessionLoader, rateLimit, csrfGuard, auditFlusher];
}
