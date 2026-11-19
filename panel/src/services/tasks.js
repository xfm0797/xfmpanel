/**
 * 任务引擎：所有可能超过 2 秒的操作（装环境、建站、签证书）都异步化为任务。
 *
 * 设计要点：
 *  - 队列落在 SQLite，进程重启不丢任务；启动时把 running 状态的任务标记为
 *    failed（结果未知），避免“假运行”；
 *  - 同一目标同一类型不允许并发（避免两个任务同时改 nginx 配置）；
 *  - 每个任务的事件流既落库（可回看）又实时推给 SSE（可观察）。
 */

import { getDb, nowIso, parseJson, paging } from '../db/index.js';
import { uuid } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { TASK_LABELS, TASK_STATUS } from '../../../shared/protocol.js';
import { errors } from '../lib/errors.js';
import { handlers } from './handlers.js';
import { config } from '../config.js';
import { getSetting } from '../db/seed.js';

const log = createLogger('tasks');

const listeners = new Map(); // taskId -> Set<fn>
const seqs = new Map(); // taskId -> last seq
const running = new Set();

export function onTaskEvent(taskId, fn) {
  if (!listeners.has(taskId)) listeners.set(taskId, new Set());
  listeners.get(taskId).add(fn);
  return () => {
    listeners.get(taskId)?.delete(fn);
    if (listeners.get(taskId)?.size === 0) listeners.delete(taskId);
  };
}

function nextSeq(taskId) {
  const cur = seqs.get(taskId) ?? 0;
  const next = cur + 1;
  seqs.set(taskId, next);
  return next;
}

function pushEvent(task, level, message) {
  const seq = nextSeq(task.id);
  const at = nowIso();
  const event = { taskId: task.id, seq, level, message, at };
  try {
    getDb().run(
      'INSERT INTO task_events (task_id, seq, level, message, at) VALUES (?, ?, ?, ?, ?)',
      [task.id, seq, level, String(message).slice(0, 4000), at],
    );
  } catch (err) {
    log.warn('任务事件落库失败', { message: err.message });
  }
  for (const fn of listeners.get(task.id) || []) {
    try { fn(event); } catch { /* ignore */ }
  }
  if (level === 'error') log.warn(`[${task.id}] ${message}`);
  return event;
}

export function getTask(id) {
  const row = getDb().get('SELECT * FROM tasks WHERE id = ?', [id]);
  return row ? mapTask(row) : null;
}

function mapTask(row) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: TASK_LABELS[row.type] || row.type,
    targetType: row.target_type,
    targetId: row.target_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    payload: parseJson(row.payload, {}),
    result: parseJson(row.result, null),
    error: row.error,
    createdBy: row.created_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function listTasks(query = {}) {
  const db = getDb();
  const { page, size, offset } = paging(query, { defaultSize: 20 });
  const where = [];
  const params = [];
  if (query.status && TASK_STATUS.includes(query.status)) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.type) { where.push('type = ?'); params.push(query.type); }
  if (query.targetType) { where.push('target_type = ?'); params.push(query.targetType); }
  if (query.targetId) { where.push('target_id = ?'); params.push(String(query.targetId)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.get(`SELECT COUNT(*) c FROM tasks ${clause}`, params).c);
  const items = db
    .all(`SELECT * FROM tasks ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, size, offset])
    .map(mapTask);
  return { items, total, page, size };
}

export function getTaskEvents(taskId, { afterSeq = 0, limit = 500 } = {}) {
  return getDb()
    .all(
      'SELECT seq, level, message, at FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [taskId, Number(afterSeq) || 0, Math.min(Number(limit) || 500, 2000)],
    );
}

export function findActiveTask({ type, targetType, targetId }) {
  const row = getDb().get(
    `SELECT * FROM tasks WHERE type = ? AND target_type = ? AND target_id = ?
     AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
    [type, targetType, String(targetId)],
  );
  return row ? mapTask(row) : null;
}

export function createTask({
  type, title, targetType = null, targetId = null, payload = {}, createdBy = null, priority = 5,
}) {
  if (!handlers[type]) throw errors.validation(`未知任务类型：${type}`, 'type');

  if (targetType && targetId != null) {
    const active = findActiveTask({ type, targetType, targetId });
    if (active) {
      throw errors.taskConflict(`该对象已有进行中的任务（${active.typeLabel}），请等待完成`);
    }
    // 同一站点不允许并发任何变更类任务
    if (String(targetType) === 'site') {
      const any = getDb().get(
        `SELECT * FROM tasks WHERE target_type = 'site' AND target_id = ?
         AND status IN ('queued','running') LIMIT 1`,
        [String(targetId)],
      );
      if (any && any.type !== type) {
        throw errors.taskConflict(`站点尚有未完成任务（${TASK_LABELS[any.type] || any.type}），请等待完成`);
      }
    }
  }

  const id = uuid();
  const now = nowIso();
  getDb().run(
    `INSERT INTO tasks (id, type, target_type, target_id, title, status, priority, payload, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    [id, type, targetType, targetId != null ? String(targetId) : null, title,
      priority, JSON.stringify(payload), createdBy, now],
  );
  return getTask(id);
}

export function cancelTask(id, actor) {
  const task = getTask(id);
  if (!task) throw errors.notFound('任务不存在');
  if (task.status !== 'queued') {
    // 运行中的任务往往正在执行 apt / certbot 等不可安全中断的特权操作，
    // 这里只允许取消尚未开始的任务，避免“面板显示已取消、agent 仍在改系统”。
    throw errors.conflict(
      task.status === 'running'
        ? '任务已开始执行，无法取消，请等待完成'
        : '任务已结束，无法取消',
    );
  }
  const db = getDb();
  db.tx(() => {
    const res = db.run(
      "UPDATE tasks SET status = 'canceled', finished_at = ?, error = ? WHERE id = ? AND status = 'queued'",
      [nowIso(), '用户取消', id],
    );
    if (Number(res.changes) !== 1) {
      throw errors.conflict('任务已开始执行，无法取消，请等待完成');
    }
    rollbackCanceledTask(task);
  });
  pushEvent(task, 'warn', `任务被 ${actor?.username || 'system'} 取消`);
  notifyFinished(id);
  return getTask(id);
}

/** 取消排队任务后，把尚未被 agent 修改的对象恢复到一致状态 */
function rollbackCanceledTask(task) {
  const db = getDb();
  const now = nowIso();
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  switch (task.type) {
    case 'site.create':
    case 'site.apply': {
      const siteId = payload.siteId ?? Number(task.targetId);
      db.run(
        "UPDATE sites SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?",
        ['任务已取消，配置可能未生效，请重新应用', now, siteId],
      );
      break;
    }
    case 'site.remove': {
      const siteId = payload.siteId ?? Number(task.targetId);
      // 删除任务未执行，站点仍保持取消前的期望状态。
      db.run(
        `UPDATE sites SET status = CASE WHEN desired_state = 'stopped' THEN 'stopped' ELSE 'active' END,
           last_error = NULL, updated_at = ? WHERE id = ?`,
        [now, siteId],
      );
      break;
    }
    case 'runtime.install': {
      db.run(
        "UPDATE runtimes SET status = 'failed', last_error = ?, updated_at = ? WHERE kind = ? AND version = ?",
        ['安装已取消', now, payload.kind, payload.version],
      );
      break;
    }
    case 'runtime.remove': {
      db.run('UPDATE runtimes SET last_error = ?, updated_at = ? WHERE id = ?', [
        '卸载已取消', now, payload.runtimeId ?? Number(task.targetId),
      ]);
      break;
    }
    case 'cert.issue':
    case 'cert.upload': {
      db.run(
        "UPDATE certificates SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
        ['任务已取消', now, payload.certId],
      );
      break;
    }
    default:
      break;
  }
}

function notifyFinished(taskId) {
  for (const fn of listeners.get(taskId) || []) {
    try { fn({ taskId, seq: -1, level: 'done', message: '任务结束', at: nowIso() }); } catch { /* ignore */ }
  }
  setTimeout(() => {
    listeners.delete(taskId);
    seqs.delete(taskId);
  }, 60_000).unref?.();
}

async function executeTask(task) {
  const ctx = {
    task,
    log: (level, msg) => pushEvent(task, level, msg),
    progress: (pct, msg) => {
      const value = Math.max(0, Math.min(100, Math.round(pct)));
      getDb().run('UPDATE tasks SET progress = ? WHERE id = ?', [value, task.id]);
      pushEvent(task, 'info', msg ? `[${value}%] ${msg}` : `进度 ${value}%`);
    },
    signal: null,
  };

  try {
    pushEvent(task, 'info', `任务开始：${task.title}`);
    const result = await handlers[task.type](ctx);
    getDb().run(
      'UPDATE tasks SET status = ?, progress = 100, result = ?, finished_at = ? WHERE id = ?',
      ['success', JSON.stringify(result ?? null), nowIso(), task.id],
    );
    pushEvent(task, 'success', '任务完成');
  } catch (err) {
    getDb().run(
      'UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?',
      ['failed', String(err.message || err).slice(0, 2000), nowIso(), task.id],
    );
    pushEvent(task, 'error', `任务失败：${err.message || err}`);
    log.error(`任务 ${task.id} (${task.type}) 失败`, { message: err.message, stack: err.stack });
  } finally {
    running.delete(task.id);
    notifyFinished(task.id);
  }
}

let timer = null;

function tick() {
  if (running.size >= config.taskConcurrency) return;
  const db = getDb();
  const slots = config.taskConcurrency - running.size;
  const rows = db.all(
    `SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT ?`,
    [slots],
  );
  for (const row of rows) {
    const claimed = db.run(
      `UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
      [nowIso(), row.id],
    );
    if (Number(claimed.changes) !== 1) continue;
    running.add(row.id);
    const task = getTask(row.id);
    executeTask(task).catch((err) => log.error('任务执行器异常', { message: err.message }));
  }
}

export function startWorker() {
  if (timer) return;
  const db = getDb();

  // 进程重启：把“运行中”标记为失败（避免永远卡在 running）
  const stale = db.run(
    `UPDATE tasks SET status = 'failed', error = ?, finished_at = ?
     WHERE status = 'running'`,
    ['面板重启导致任务中断，请重试', nowIso()],
  );
  if (Number(stale.changes) > 0) {
    log.warn(`有 ${stale.changes} 个任务因面板重启被标记为失败`);
  }

  // 任务中断后，对象可能停留在中间态；没有待执行任务时统一迁到可重试状态。
  const staleRuntimes = db.run(
    `UPDATE runtimes SET status = 'failed', last_error = ?, updated_at = ?
     WHERE status = 'installing'
       AND NOT EXISTS (
         SELECT 1 FROM tasks
         WHERE tasks.status = 'queued' AND tasks.type = 'runtime.install'
           AND json_extract(tasks.payload, '$.kind') = runtimes.kind
           AND json_extract(tasks.payload, '$.version') = runtimes.version
       )`,
    ['面板重启导致安装中断，请重试', nowIso()],
  );
  const staleSites = db.run(
    `UPDATE sites SET status = 'error', last_error = ?, updated_at = ?
     WHERE status IN ('pending', 'deleting')
       AND NOT EXISTS (
         SELECT 1 FROM tasks
         WHERE tasks.status = 'queued' AND tasks.target_type = 'site'
           AND tasks.target_id = CAST(sites.id AS TEXT)
       )`,
    ['面板重启导致操作中断，请重试', nowIso()],
  );
  if (Number(staleRuntimes.changes) > 0) {
    log.warn(`有 ${staleRuntimes.changes} 个运行时因面板重启被标记为失败`);
  }
  if (Number(staleSites.changes) > 0) {
    log.warn(`有 ${staleSites.changes} 个站点因面板重启被标记为异常`);
  }

  timer = setInterval(() => {
    try { tick(); } catch (err) { log.error('任务调度异常', { message: err.message }); }
  }, config.taskPollMs);
  timer.unref?.();
  tick();
  log.info(`任务引擎已启动（并发 ${config.taskConcurrency}）`);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 清理历史任务与事件，避免 SQLite 无限膨胀 */
export function cleanupOldTasks() {
  const settingDays = Number(getSetting('ops.taskRetentionDays', config.taskRetentionDays));
  const days = Number.isFinite(settingDays) && settingDays > 0 ? settingDays : config.taskRetentionDays;
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const res = getDb().run(
    "DELETE FROM tasks WHERE created_at < ? AND status IN ('success','failed','canceled')",
    [cutoff],
  );
  return res.changes;
}

export function taskStats() {
  const rows = getDb().all('SELECT status, COUNT(*) c FROM tasks GROUP BY status');
  const out = { queued: 0, running: 0, success: 0, failed: 0, canceled: 0 };
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

export { pushEvent };
