/**
 * 认证接口：登录 / 登出 / 当前身份 / 改密。
 *
 * 防暴力破解采取三层：
 *   1) 全局 IP 限流（security.rateLimit）
 *   2) login_throttle 表：按 IP 与用户名分别计数，超阈值锁定 15 分钟
 *   3) 用户维度 failed_attempts，跨 IP 也生效
 */

import { getDb, nowIso } from '../db/index.js';
import { createSession, revokeSession, SESSION_COOKIE } from '../services/sessions.js';
import { getUserByUsername, getUserById, permissionsOf, changeOwnPassword } from '../services/users.js';
import { record } from '../services/audit.js';
import { verifyPassword } from '../lib/crypto.js';
import { errors, HttpError } from '../lib/errors.js';
import { requireLogin } from '../http/security.js';
import { config, isHttpsRequest } from '../config.js';
import { getSettings } from '../db/seed.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { assertString } from '../../../shared/validate.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auth');

function throttleKeys(ip, username) {
  return [`ip:${ip}`, `user:${username}`];
}

function checkThrottle(keys) {
  const db = getDb();
  const now = Date.now();
  for (const key of keys) {
    const row = db.get('SELECT * FROM login_throttle WHERE key = ?', [key]);
    if (row?.blocked_until && new Date(row.blocked_until).getTime() > now) {
      const mins = Math.ceil((new Date(row.blocked_until).getTime() - now) / 60000);
      throw new HttpError('ACCOUNT_LOCKED', {
        message: `尝试次数过多，请 ${mins} 分钟后再试`,
      });
    }
  }
}

function bumpThrottle(keys) {
  const db = getDb();
  const now = new Date();
  for (const key of keys) {
    const row = db.get('SELECT * FROM login_throttle WHERE key = ?', [key]);
    if (!row) {
      db.run('INSERT INTO login_throttle (key, count, first_at) VALUES (?, 1, ?)', [key, now.toISOString()]);
      continue;
    }
    const count = Number(row.count) + 1;
    const blocked = count >= config.loginMaxAttempts
      ? new Date(Date.now() + config.loginLockMinutes * 60000).toISOString()
      : null;
    db.run('UPDATE login_throttle SET count = ?, blocked_until = ? WHERE key = ?', [count, blocked, key]);
  }
}

function clearThrottle(keys) {
  const db = getDb();
  for (const key of keys) db.run('DELETE FROM login_throttle WHERE key = ?', [key]);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    permissions: permissionsOf(user.role),
    lastLoginAt: user.lastLoginAt,
  };
}

export function registerAuthRoutes(app) {
  app.post('/api/v1/auth/login', async (ctx) => {
    const username = assertString(ctx.body?.username, { field: 'username', min: 1, max: 64 });
    const password = assertString(ctx.body?.password, { field: 'password', min: 1, max: 128, trim: false });

    const keys = throttleKeys(ctx.ip, username);
    checkThrottle(keys);

    const user = getUserByUsername(username);
    const fail = (reason, shouldAudit = true) => {
      bumpThrottle(keys);
      if (shouldAudit) {
        record({
          actor: { id: user?.id, username },
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          resource: 'auth',
          result: 'failed',
          detail: { reason },
          ip: ctx.ip,
          ua: ctx.ua,
        });
      }
      throw new HttpError('AUTH_FAILED', { message: '用户名或密码错误' });
    };

    if (!user) fail('user_not_found');
    if (user.status !== 'active') {
      record({
        actor: { id: user.id, username },
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        resource: 'auth',
        result: 'failed',
        detail: { reason: 'disabled' },
        ip: ctx.ip,
        ua: ctx.ua,
      });
      throw new HttpError('FORBIDDEN', { message: '账号已被禁用，请联系管理员' });
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new HttpError('ACCOUNT_LOCKED', { message: '账号已被临时锁定，请稍后再试' });
    }
    if (!verifyPassword(password, user.password_hash)) {
      const attempts = Number(user.failed_attempts) + 1;
      const locked = attempts >= config.loginMaxAttempts
        ? new Date(Date.now() + config.loginLockMinutes * 60000).toISOString()
        : null;
      getDb().run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [
        attempts, locked, user.id,
      ]);
      fail('bad_password');
    }

    clearThrottle(keys);
    getDb().run(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?',
      [nowIso(), ctx.ip, user.id],
    );

    const session = createSession(user.id, { ip: ctx.ip, ua: ctx.ua });
    ctx.setCookie(SESSION_COOKIE, session.token, {
      maxAge: config.sessionTtlHours * 3600,
      secure: isHttpsRequest(ctx.req),
    });

    record({
      actor: { id: user.id, username: user.username },
      action: AUDIT_ACTIONS.LOGIN,
      resource: 'auth',
      ip: ctx.ip,
      ua: ctx.ua,
      detail: { sessionExpiresAt: session.expiresAt },
    });
    log.info(`${username} 登录成功`, { ip: ctx.ip });

    return ctx.json({
      ok: true,
      data: {
        user: publicUser(getUserById(user.id)),
        csrfToken: session.csrf,
        expiresAt: session.expiresAt,
      },
    });
  });

  app.get('/api/v1/auth/me', requireLogin(), async (ctx) => {
    return {
      user: publicUser(ctx.user),
      csrfToken: ctx.session.csrf_token,
      settings: sanitizeSettings(getSettings('panel.')),
    };
  });

  app.post('/api/v1/auth/logout', requireLogin(), async (ctx) => {
    const token = ctx.cookies[SESSION_COOKIE];
    revokeSession(token);
    ctx.clearCookie(SESSION_COOKIE);
    ctx.audit(AUDIT_ACTIONS.LOGOUT, { resource: 'auth' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password', requireLogin(), async (ctx) => {
    const oldPassword = assertString(ctx.body?.oldPassword, { field: 'oldPassword', min: 1, max: 128, trim: false });
    const newPassword = assertString(ctx.body?.newPassword, { field: 'newPassword', min: 10, max: 128, trim: false });
    changeOwnPassword(ctx.user.id, oldPassword, newPassword, ctx.session.id);
    ctx.audit(AUDIT_ACTIONS.PASSWORD_CHANGE, { resource: 'user', resourceId: ctx.user.id });
    // 其它会话已被踢下线，当前会话保留
    return { ok: true };
  });
}

function sanitizeSettings(all) {
  return Object.fromEntries(Object.entries(all).filter(([k]) => !/secret|key|password/i.test(k)));
}
