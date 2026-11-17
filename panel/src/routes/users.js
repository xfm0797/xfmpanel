/**
 * 用户管理接口（仅超级管理员）。
 */

import { perm } from '../http/security.js';
import { listUsers, createUser, updateUser, deleteUser, getUserById } from '../services/users.js';
import { ROLE_NAMES, ROLES, AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { assertInt, assertString } from '../../../shared/validate.js';

export function registerUserRoutes(app) {
  app.get('/api/v1/users', perm('user:read'), async () => ({
    items: listUsers(),
    roles: ROLE_NAMES.map((name) => ({
      name,
      label: ROLES[name].label,
      permissions: ROLES[name].permissions,
    })),
  }));

  app.post('/api/v1/users', perm('user:write'), async (ctx) => {
    const user = createUser({
      username: assertString(ctx.body?.username, { field: 'username', min: 3, max: 32, pattern: /^[a-zA-Z0-9_.-]+$/ }),
      password: String(ctx.body?.password || ''),
      displayName: ctx.body?.displayName ? String(ctx.body.displayName) : '',
      role: ctx.body?.role || 'operator',
    }, ctx.user);
    ctx.audit(AUDIT_ACTIONS.USER_CREATE, {
      resource: 'user',
      resourceId: user.id,
      detail: { username: user.username, role: user.role },
    });
    return ctx.json({ ok: true, data: user }, 201);
  });

  app.patch('/api/v1/users/:id', perm('user:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const before = getUserById(id);
    const user = updateUser(id, ctx.body || {});
    ctx.audit(AUDIT_ACTIONS.USER_UPDATE, {
      resource: 'user',
      resourceId: id,
      detail: {
        username: before?.username,
        changes: Object.keys(ctx.body || {}).filter((k) => k !== 'password'),
        passwordReset: Boolean(ctx.body?.password),
      },
    });
    return user;
  });

  app.delete('/api/v1/users/:id', perm('user:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const before = getUserById(id);
    const result = deleteUser(id, ctx.user.id);
    ctx.audit(AUDIT_ACTIONS.USER_DELETE, {
      resource: 'user',
      resourceId: id,
      detail: { username: before?.username },
    });
    return result;
  });
}
