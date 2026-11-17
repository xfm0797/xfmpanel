/**
 * 站点接口。
 */

import { perm } from '../http/security.js';
import {
  listSites, getSiteDetail, createSite, updateSite, deleteSite, previewConfig, siteStats, getSite,
} from '../services/sites.js';
import { createTask } from '../services/tasks.js';
import { callAgent } from '../services/agent.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { errors } from '../lib/errors.js';
import { assertInt } from '../../../shared/validate.js';

export function registerSiteRoutes(app) {
  app.get('/api/v1/sites', perm('site:read'), async (ctx) => {
    return listSites(ctx.query);
  });

  app.get('/api/v1/sites/stats', perm('site:read'), async () => siteStats());

  app.get('/api/v1/sites/:id', perm('site:read'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    return getSiteDetail(id);
  });

  app.post('/api/v1/sites', perm('site:write'), async (ctx) => {
    const result = createSite(ctx.body || {}, ctx.user);
    ctx.audit(AUDIT_ACTIONS.SITE_CREATE, {
      resource: 'site',
      resourceId: result.site.id,
      detail: {
        slug: result.site.slug,
        domains: result.site.domains,
        appType: result.site.appType,
        phpVersion: result.site.phpVersion,
        taskId: result.task.id,
      },
    });
    return ctx.json({ ok: true, data: result }, 201);
  });

  app.patch('/api/v1/sites/:id', perm('site:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const result = updateSite(id, ctx.body || {}, ctx.user);
    ctx.audit(AUDIT_ACTIONS.SITE_UPDATE, {
      resource: 'site',
      resourceId: id,
      detail: { changes: Object.keys(ctx.body || {}), taskId: result.task?.id },
    });
    return result;
  });

  app.delete('/api/v1/sites/:id', perm('site:delete'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const keepFiles = ctx.query.keepFiles !== '0';
    const backup = ctx.query.backup !== '0';
    const result = deleteSite(id, { keepFiles, backup }, ctx.user);
    ctx.audit(AUDIT_ACTIONS.SITE_DELETE, {
      resource: 'site',
      resourceId: id,
      detail: { keepFiles, backup, taskId: result.task.id },
    });
    return result;
  });

  /** 站点启停：改期望状态 → 触发 site.apply（幂等，配置从数据库重新渲染） */
  app.post('/api/v1/sites/:id/state', perm('site:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const status = ctx.body?.status;
    if (!['active', 'stopped'].includes(status)) {
      throw errors.validation('status 只能是 active 或 stopped', 'status');
    }
    const result = updateSite(id, { status }, ctx.user);
    ctx.audit(AUDIT_ACTIONS.SITE_ACTION, {
      resource: 'site',
      resourceId: id,
      detail: { action: status === 'active' ? 'enable' : 'disable', taskId: result.task?.id },
    });
    return result;
  });

  app.post('/api/v1/sites/:id/reload', perm('site:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const site = getSite(id);
    const task = createTask({
      type: 'site.action',
      title: `重载服务（${site.name}）`,
      targetType: 'site',
      targetId: String(id),
      payload: { siteId: id, action: 'reload' },
      createdBy: ctx.user.id,
      priority: 4,
    });
    ctx.audit(AUDIT_ACTIONS.SITE_ACTION, {
      resource: 'site',
      resourceId: id,
      detail: { action: 'reload', taskId: task.id },
    });
    return { task };
  });

  /** 配置预览：与 agent 落盘同源渲染，便于排障与代码评审 */
  app.get('/api/v1/sites/:id/config', perm('site:read'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    return previewConfig(id);
  });

  app.get('/api/v1/sites/:id/logs', perm('log:read'), async (ctx) => {
    const site = getSite(assertInt(ctx.params.id, { field: 'id', min: 1 }));
    const type = ctx.query.type === 'error' ? 'error' : 'access';
    const lines = Math.min(Math.max(Number(ctx.query.lines) || 200, 10), 2000);
    const res = await callAgent('site.log.tail', { slug: site.slug, type, lines }, { timeoutMs: 8000 });
    return { type, lines: res.lines || [], slug: site.slug };
  });

  app.get('/api/v1/sites/:id/usage', perm('site:read'), async (ctx) => {
    const site = getSite(assertInt(ctx.params.id, { field: 'id', min: 1 }));
    try {
      return await callAgent('site.usage', { root: site.rootPath, slug: site.slug }, { timeoutMs: 8000 });
    } catch (err) {
      return { unavailable: true, error: err.message };
    }
  });

  /** DNS 预检：签发证书前给出明确提示，而不是等 ACME 失败 */
  app.get('/api/v1/sites/:id/dns-check', perm('cert:read'), async (ctx) => {
    const site = getSite(assertInt(ctx.params.id, { field: 'id', min: 1 }));
    const checks = [];
    for (const domain of site.domains.slice(0, 5)) {
      try {
        const res = await callAgent('dns.check', { domain }, { timeoutMs: 6000 });
        checks.push({ domain, ...res });
      } catch (err) {
        checks.push({ domain, resolved: null, error: err.message });
      }
    }
    return { checks };
  });
}
