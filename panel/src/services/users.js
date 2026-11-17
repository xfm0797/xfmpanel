/**
 * 用户与权限。
 */

import { getDb, nowIso, paging } from '../db/index.js';
import { hashPassword, verifyPassword, checkPasswordStrength } from '../lib/crypto.js';
import { ROLES } from '../../../shared/protocol.js';
import { errors } from '../lib/errors.js';
import { revokeUserSessions } from './sessions.js';

const PUBLIC_FIELDS = `id, username, display_name as displayName, role, status,
  last_login_at as lastLoginAt, last_login_ip as lastLoginIp, created_at as createdAt,
  locked_until as lockedUntil, failed_attempts as failedAttempts`;

export function permissionsOf(role) {
  const def = ROLES[role];
  if (!def) return [];
  return def.permissions;
}

export function hasPermission(user, perm) {
  if (!user) return false;
  const perms = permissionsOf(user.role);
  return perms.includes('*') || perms.includes(perm);
}

export function getUserById(id) {
  return getDb().get(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, [id]);
}

export function getUserByUsername(username) {
  return getDb().get('SELECT * FROM users WHERE username = ?', [username]);
}

export function listUsers() {
  return getDb().all(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY id ASC`);
}

export function createUser({ username, password, displayName = '', role = 'operator' }, actor) {
  const db = getDb();
  if (getUserByUsername(username)) {
    throw errors.conflict('用户名已存在', { field: 'username' });
  }
  if (!ROLES[role]) throw errors.validation('角色不合法', 'role');
  const strength = checkPasswordStrength(password);
  if (!strength.ok) throw errors.validation(strength.message, 'password');

  const now = nowIso();
  const res = db.run(
    `INSERT INTO users (username, display_name, password_hash, role, status, password_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [username, displayName || username, hashPassword(password), role, now, now, now],
  );
  return getUserById(Number(res.lastInsertRowid));
}

export function updateUser(id, patch) {
  const db = getDb();
  const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw errors.notFound('用户不存在');

  const fields = [];
  const params = [];
  if (patch.displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(String(patch.displayName).slice(0, 64));
  }
  if (patch.role !== undefined) {
    if (!ROLES[patch.role]) throw errors.validation('角色不合法', 'role');
    // 不允许把最后一个 owner 降级
    if (user.role === 'owner' && patch.role !== 'owner') assertNotLastOwner(id);
    fields.push('role = ?');
    params.push(patch.role);
  }
  if (patch.status !== undefined) {
    if (!['active', 'disabled'].includes(patch.status)) throw errors.validation('状态不合法', 'status');
    if (user.role === 'owner' && patch.status !== 'active') assertNotLastOwner(id);
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.password !== undefined) {
    const strength = checkPasswordStrength(patch.password);
    if (!strength.ok) throw errors.validation(strength.message, 'password');
    fields.push('password_hash = ?', 'password_changed_at = ?', 'failed_attempts = 0', 'locked_until = NULL');
    params.push(hashPassword(patch.password), nowIso());
  }
  if (!fields.length) return getUserById(id);

  fields.push('updated_at = ?');
  params.push(nowIso(), id);
  db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  if (patch.password !== undefined || patch.status === 'disabled') {
    revokeUserSessions(id);
  }
  return getUserById(id);
}

export function deleteUser(id, actorId) {
  if (id === actorId) throw errors.validation('不能删除当前登录账号', 'id');
  const db = getDb();
  const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw errors.notFound('用户不存在');
  if (user.role === 'owner') assertNotLastOwner(id);
  db.run('DELETE FROM users WHERE id = ?', [id]);
  return { id };
}

function assertNotLastOwner(excludeId) {
  const row = getDb().get(
    "SELECT COUNT(*) as c FROM users WHERE role = 'owner' AND status = 'active' AND id <> ?",
    [excludeId],
  );
  if (!row || Number(row.c) === 0) {
    throw errors.conflict('系统必须保留至少一个启用状态的超级管理员');
  }
}

export function changeOwnPassword(userId, oldPassword, newPassword, currentSessionId) {
  const db = getDb();
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw errors.notFound('用户不存在');
  if (!verifyPassword(oldPassword, user.password_hash)) {
    throw errors.validation('原密码不正确', 'oldPassword');
  }
  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) throw errors.validation(strength.message, 'newPassword');
  db.run(
    'UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?',
    [hashPassword(newPassword), nowIso(), nowIso(), userId],
  );
  revokeUserSessions(userId, { exceptSessionId: currentSessionId });
  return true;
}

export function listAuditLogs(query = {}) {
  const db = getDb();
  const { page, size, offset } = paging(query, { defaultSize: 30 });
  const where = [];
  const params = [];
  if (query.action) { where.push('action LIKE ?'); params.push(`${query.action}%`); }
  if (query.actor) { where.push('actor_name = ?'); params.push(query.actor); }
  if (query.result) { where.push('result = ?'); params.push(query.result); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.get(`SELECT COUNT(*) c FROM audit_logs ${clause}`, params).c);
  const items = db.all(
    `SELECT id, actor_id as actorId, actor_name as actorName, action, resource, resource_id as resourceId,
            result, ip, detail, at
     FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { items, page, size, total };
}
