/**
 * 网站环境（运行时）接口。
 */

import { perm } from '../http/security.js';
import {
  listRuntimes, installRuntime, removeRuntime, setDefaultRuntime, serviceAction,
  runtimeHealth, getRuntime,
} from '../services/runtimes.js';
import { listCatalog } from '../services/catalog.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { assertInt } from '../../../shared/validate.js';

export function registerRuntimeRoutes(app) {
  app.get('/api/v1/runtimes', perm('runtime:read'), async () => listRuntimes());

  app.get('/api/v1/runtimes/catalog', perm('runtime:read'), async () => listCatalog());

  app.get('/api/v1/runtimes/health', perm('runtime:read'), async () => ({
    services: await runtimeHealth(),
  }));

  app.post('/api/v1/runtimes/install', perm('runtime:write'), async (ctx) => {
    const { kind, version } = ctx.body || {};
    const result = installRuntime({ kind, version }, ctx.user);
    ctx.audit(AUDIT_ACTIONS.RUNTIME_INSTALL, {
      resource: 'runtime',
      resourceId: `${kind}:${version}`,
      detail: { kind, version, taskId: result.task.id },
    });
    return ctx.json({ ok: true, data: result }, 202);
  });

  app.post('/api/v1/runtimes/:id/default', perm('runtime:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const row = getRuntime(id);
    const result = setDefaultRuntime(id);
    ctx.audit(AUDIT_ACTIONS.RUNTIME_ACTIVATE, {
      resource: 'runtime',
      resourceId: id,
      detail: { kind: row.kind, version: row.version },
    });
    return result;
  });

  app.post('/api/v1/runtimes/:id/service', perm('runtime:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const action = ctx.body?.action;
    const result = await serviceAction(id, action, ctx.user);
    ctx.audit(AUDIT_ACTIONS.RUNTIME_ACTIVATE, {
      resource: 'runtime',
      resourceId: id,
      detail: { action },
    });
    return result;
  });

  app.delete('/api/v1/runtimes/:id', perm('runtime:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const row = getRuntime(id);
    const result = removeRuntime(id, ctx.user);
    ctx.audit(AUDIT_ACTIONS.RUNTIME_REMOVE, {
      resource: 'runtime',
      resourceId: id,
      detail: { kind: row.kind, version: row.version, taskId: result.task.id },
    });
    return result;
  });
}
