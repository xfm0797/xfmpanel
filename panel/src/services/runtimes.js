/**
 * 网站环境（运行时）服务：安装、卸载、默认版本、服务控制。
 */

import { getDb, nowIso, parseJson } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { CATALOG, listCatalog, isValidVersion, serviceNameFor } from './catalog.js';
import { createTask } from './tasks.js';
import { callAgent } from './agent.js';
import { assertEnum } from '../../../shared/validate.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('runtimes');

export function listRuntimes() {
  const db = getDb();
  const installed = db.all('SELECT * FROM runtimes ORDER BY kind, version DESC').map((r) => ({
    id: r.id,
    kind: r.kind,
    version: r.version,
    status: r.status,
    isDefault: Number(r.is_default) === 1,
    serviceName: r.service_name,
    installPath: r.install_path,
    configPath: r.config_path,
    meta: parseJson(r.meta, {}),
    lastError: r.last_error,
    installedAt: r.installed_at,
    updatedAt: r.updated_at,
  }));

  const groups = listCatalog().map((item) => {
    const rows = installed.filter((r) => r.kind === item.kind);
    return {
      kind: item.kind,
      label: item.label,
      description: item.description,
      versions: item.versions,
      installed: rows,
      hasActive: rows.some((r) => r.status === 'active'),
    };
  });

  const pendingTasks = db.all(
    `SELECT id, type, target_id as targetId, status, progress FROM tasks
     WHERE type LIKE 'runtime.%' AND status IN ('queued','running')`,
  );

  return { groups, installed, pendingTasks };
}

export function getRuntime(id) {
  const row = getDb().get('SELECT * FROM runtimes WHERE id = ?', [id]);
  if (!row) throw errors.notFound('运行环境不存在');
  return row;
}

export function installRuntime({ kind, version }, actor) {
  const item = CATALOG[kind];
  if (!item) throw errors.validation('不支持的组件类型', 'kind');
  if (!isValidVersion(kind, version)) throw errors.validation('该版本不在支持列表中', 'version');

  const db = getDb();
  const existing = db.get('SELECT * FROM runtimes WHERE kind = ? AND version = ?', [kind, String(version)]);
  if (existing && existing.status === 'active') {
    throw errors.conflict(`${item.label} ${version} 已安装并运行中`);
  }
  if (existing && existing.status === 'installing') {
    throw errors.conflict(`${item.label} ${version} 正在安装中`);
  }

  const now = nowIso();
  if (existing) {
    db.run('UPDATE runtimes SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?', [
      'installing', now, existing.id,
    ]);
  } else {
    db.run(
      `INSERT INTO runtimes (kind, version, status, service_name, created_at, updated_at)
       VALUES (?, ?, 'installing', ?, ?, ?)`,
      [kind, String(version), serviceNameFor(kind, version), now, now],
    );
  }

  const task = createTask({
    type: 'runtime.install',
    title: `安装 ${item.label} ${version}`,
    targetType: 'runtime',
    targetId: `${kind}:${version}`,
    payload: { kind, version: String(version) },
    createdBy: actor?.id ?? null,
    priority: 1,
  });

  log.info(`开始安装 ${kind} ${version}`, { taskId: task.id });
  return { task };
}

export function removeRuntime(id, actor) {
  const row = getRuntime(id);
  if (row.kind === 'nginx') {
    const sites = Number(getDb().get('SELECT COUNT(*) c FROM sites').c);
    if (sites > 0) throw errors.conflict('存在站点时不能卸载 Nginx，请先删除所有站点');
  }
  if (row.kind === 'php') {
    const used = Number(
      getDb().get('SELECT COUNT(*) c FROM sites WHERE php_version = ?', [row.version]).c,
    );
    if (used > 0) throw errors.conflict(`仍有 ${used} 个站点使用 PHP ${row.version}，请先切换版本`);
  }

  getDb().run('UPDATE runtimes SET status = ?, updated_at = ? WHERE id = ?', ['failed', nowIso(), id]);
  const task = createTask({
    type: 'runtime.remove',
    title: `卸载 ${CATALOG[row.kind]?.label || row.kind} ${row.version}`,
    targetType: 'runtime',
    targetId: String(id),
    payload: { runtimeId: id, kind: row.kind, version: row.version, serviceName: row.service_name },
    createdBy: actor?.id ?? null,
    priority: 2,
  });
  return { task };
}

export function setDefaultRuntime(id) {
  const row = getRuntime(id);
  if (row.status !== 'active') throw errors.conflict('只有运行中的环境才能设为默认');
  const db = getDb();
  db.tx(() => {
    db.run('UPDATE runtimes SET is_default = 0 WHERE kind = ?', [row.kind]);
    db.run('UPDATE runtimes SET is_default = 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
  });
  return { ok: true };
}

export async function serviceAction(id, action, actor) {
  const row = getRuntime(id);
  const act = assertEnum(action, ['start', 'stop', 'restart', 'reload'], 'action');
  if (!row.service_name) throw errors.validation('该组件没有可控制的服务', 'action');
  const result = await callAgent('service.action', { unit: row.service_name, action: act });
  const nextStatus = act === 'stop' ? 'stopped' : 'active';
  getDb().run('UPDATE runtimes SET status = ?, updated_at = ? WHERE id = ?', [nextStatus, nowIso(), id]);
  return { ...result, status: nextStatus };
}

/** 仪表盘用：一次性拉取所有关键服务状态 */
export async function runtimeHealth() {
  const db = getDb();
  const items = db.all("SELECT * FROM runtimes WHERE status = 'active' AND service_name IS NOT NULL");
  const out = [];
  for (const row of items) {
    try {
      const st = await callAgent('service.status', { unit: row.service_name }, { timeoutMs: 4000 });
      out.push({
        id: row.id,
        kind: row.kind,
        version: row.version,
        unit: row.service_name,
        active: Boolean(st.active),
        since: st.since,
      });
    } catch (err) {
      out.push({
        id: row.id,
        kind: row.kind,
        version: row.version,
        unit: row.service_name,
        active: false,
        error: err.message,
      });
    }
  }
  return out;
}
