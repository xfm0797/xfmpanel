/**
 * 审计日志：所有写操作都必须留痕（谁、从哪个 IP、对哪个资源做了什么、结果如何）。
 */

import { getDb, nowIso } from '../db/index.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('audit');

export function record({ actor, action, resource, resourceId, detail, result = 'success', ip, ua }) {
  try {
    getDb().run(
      `INSERT INTO audit_logs (actor_id, actor_name, action, resource, resource_id, result, ip, user_agent, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor?.id ?? null,
        actor?.username || 'system',
        action,
        resource ?? null,
        resourceId != null ? String(resourceId) : null,
        result,
        ip ?? null,
        ua ? String(ua).slice(0, 300) : null,
        JSON.stringify(detail ?? {}),
        nowIso(),
      ],
    );
  } catch (err) {
    // 审计写入失败不能阻塞业务，但必须留下痕迹
    log.error('审计日志写入失败', { message: err.message, action });
  }
}

/** 按保留期清理审计日志，避免 SQLite 无限膨胀 */
export function cleanupAuditLogs() {
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 86400 * 1000).toISOString();
  return getDb().run('DELETE FROM audit_logs WHERE at < ?', [cutoff]).changes;
}

/** 供路由层便捷调用：ctx.audit('site.create', {...}) */
export function flushContextAudit(ctx) {
  const a = ctx.locals?.audit;
  if (!a) return;
  let detail = a.detail;
  if (typeof detail === 'function') {
    try { detail = detail(); } catch { detail = undefined; }
  }
  record({
    actor: ctx.user,
    action: a.action,
    resource: a.resource,
    resourceId: a.resourceId,
    result: a.result,
    detail,
    ip: ctx.ip,
    ua: ctx.ua,
  });
  ctx.locals.audit = null;
}
