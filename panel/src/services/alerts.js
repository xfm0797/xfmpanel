/**
 * 告警中心：证书临期/过期、任务失败、站点异常、agent 离线都汇聚到这里。
 * 未确认的告警按 dedupe_key 去重，避免同一个问题刷屏。
 */

import { getDb, nowIso, paging } from '../db/index.js';
import { getSetting } from '../db/seed.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('alerts');

/** 新告警异步推送到 notify.webhookUrl（失败只记日志，不影响主流程） */
function sendWebhook(alert) {
  let url = '';
  try {
    url = String(getSetting('notify.webhookUrl', '') || '').trim();
  } catch {
    return;
  }
  if (!/^https?:\/\//i.test(url)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'alert', alert }),
    signal: controller.signal,
  })
    .catch((err) => log.warn(`告警 Webhook 推送失败：${err.message}`))
    .finally(() => clearTimeout(timer));
}

export function raise({
  level = 'warning',
  source,
  code,
  title,
  message = '',
  resource = null,
  dedupeKey = null,
}) {
  const db = getDb();
  const key = dedupeKey || `${source}:${code}:${resource || ''}`;
  const existing = db.get(
    'SELECT * FROM alerts WHERE dedupe_key = ? AND acknowledged = 0 ORDER BY id DESC LIMIT 1',
    [key],
  );
  const now = nowIso();
  if (existing) {
    db.run('UPDATE alerts SET level = ?, title = ?, message = ?, updated_at = ? WHERE id = ?', [
      level, title, message, now, existing.id,
    ]);
    return { id: existing.id, updated: true };
  }
  const res = db.run(
    `INSERT INTO alerts (level, source, code, title, message, resource, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [level, source, code, title, message, resource, key, now, now],
  );
  log.warn(`新告警 [${level}] ${title}`);
  const id = Number(res.lastInsertRowid);
  sendWebhook({ id, level, source, code, title, message, resource, at: now });
  return { id, updated: false };
}

/** 条件恢复后自动关闭对应告警 */
export function resolve(source, code, resource = null) {
  const key = `${source}:${code}:${resource || ''}`;
  const res = getDb().run(
    'UPDATE alerts SET acknowledged = 1, ack_at = ?, updated_at = ? WHERE dedupe_key = ? AND acknowledged = 0',
    [nowIso(), nowIso(), key],
  );
  return Number(res.changes);
}

export function listAlerts(query = {}) {
  const db = getDb();
  const { page, size, offset } = paging(query, { defaultSize: 20 });
  const where = [];
  const params = [];
  if (query.open === '1' || query.open === 'true') where.push('acknowledged = 0');
  if (query.level) { where.push('level = ?'); params.push(query.level); }
  if (query.source) { where.push('source = ?'); params.push(query.source); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.get(`SELECT COUNT(*) c FROM alerts ${clause}`, params).c);
  const items = db.all(
    `SELECT id, level, source, code, title, message, resource, acknowledged,
            ack_at as ackAt, created_at as createdAt, updated_at as updatedAt
     FROM alerts ${clause} ORDER BY acknowledged ASC, id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { items, total, page, size };
}

export function ackAlert(id, userId) {
  const res = getDb().run(
    'UPDATE alerts SET acknowledged = 1, ack_by = ?, ack_at = ?, updated_at = ? WHERE id = ?',
    [userId, nowIso(), nowIso(), id],
  );
  return Number(res.changes) > 0;
}

export function openAlertCount() {
  return Number(getDb().get('SELECT COUNT(*) c FROM alerts WHERE acknowledged = 0').c);
}
