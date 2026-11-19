/**
 * 会话管理：随机令牌 + 服务端哈希存储 + 滑动过期。
 * Cookie 只承载令牌本体，数据库只存 sha256，库泄漏也无法直接冒用会话。
 */

import { getDb, nowIso } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { getSetting } from '../db/seed.js';

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** 会话时长以设置为准，非法值回退到环境变量默认 */
function sessionTtlHours() {
  const n = Number(getSetting('security.sessionTtlHours', config.sessionTtlHours));
  return Number.isFinite(n) && n > 0 ? n : config.sessionTtlHours;
}

export function createSession(userId, { ip = '', ua = '' } = {}) {
  const db = getDb();
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + sessionTtlHours() * 3600 * 1000);

  db.run(
    `INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, csrf, ip, ua, now.toISOString(), now.toISOString(), expires.toISOString()],
  );

  return { token, csrf, expiresAt: expires.toISOString() };
}

export function findSession(token) {
  if (!token) return null;
  const db = getDb();
  const id = sha256(token);
  const row = db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), id]);
    return null;
  }
  return row;
}

export function touchSession(session) {
  const last = new Date(session.last_seen_at).getTime();
  if (Date.now() - last < TOUCH_INTERVAL_MS) return;
  const expires = new Date(Date.now() + sessionTtlHours() * 3600 * 1000).toISOString();
  getDb().run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [
    nowIso(), expires, session.id,
  ]);
}

export function revokeSession(token) {
  if (!token) return;
  getDb().run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), sha256(token)]);
}

export function revokeUserSessions(userId, { exceptSessionId } = {}) {
  const db = getDb();
  if (exceptSessionId) {
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [
      nowIso(), userId, exceptSessionId,
    ]);
  } else {
    db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
      nowIso(), userId,
    ]);
  }
}

export function cleanupExpiredSessions() {
  const db = getDb();
  const res = db.run('DELETE FROM sessions WHERE expires_at < ?', [
    new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  ]);
  return res.changes;
}

export const SESSION_COOKIE = 'xfm_sid';
