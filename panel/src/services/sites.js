/**
 * 站点服务：参数校验、状态机、配置规格组装。
 *
 * 所有落盘动作都在 agent 侧完成；这里只负责“把用户意图变成受校验的结构化规格”，
 * 再交给任务引擎异步执行，保证 HTTP 请求快速返回且可观察进度。
 */

import { getDb, nowIso, parseJson, stringifyJson, paging } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { config } from '../config.js';
import {
  assertSlug, assertDomains, assertEnum, assertString, assertPhpVersion, assertInt,
} from '../../../shared/validate.js';
import { siteRoot, siteUser, phpSocketPath } from '../../../shared/paths.js';
import { createTask } from './tasks.js';
import { getSetting } from '../db/seed.js';
import { SITE_STATUS } from '../../../shared/protocol.js';
import { createLogger } from '../lib/logger.js';
import { renderSiteVhost } from '../../../shared/render/nginx.js';
import { renderPhpPool } from '../../../shared/render/php-pool.js';

const log = createLogger('sites');

const SETTING_RULES = {
  rewrite: { type: 'enum', values: ['none', 'wordpress', 'laravel', 'thinkphp', 'discuz'], default: 'none' },
  clientMaxBodySizeMb: { type: 'int', min: 1, max: 4096, default: 64 },
  // 小内存机型默认更小的 PHP 进程池与单进程上限，避免多站点叠加后 OOM
  maxChildren: { type: 'int', min: 2, max: 80, default: config.lowMemory ? 3 : 10 },
  memoryLimitMb: { type: 'int', min: 32, max: 4096, default: config.lowMemory ? 128 : 256 },
  maxExecutionTime: { type: 'int', min: 10, max: 900, default: 120 },
  uploadMaxFilesizeMb: { type: 'int', min: 1, max: 2048, default: 64 },
  forceHttps: { type: 'bool', default: true },
  disabledFunctions: { type: 'fnlist', default: [] },
};

export function normalizeSettings(input = {}) {
  const out = {};
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    const raw = input[key];
    if (raw === undefined) {
      out[key] = rule.default;
      continue;
    }
    if (rule.type === 'enum') out[key] = assertEnum(String(raw), rule.values, `settings.${key}`);
    else if (rule.type === 'int') out[key] = assertInt(raw, { field: `settings.${key}`, min: rule.min, max: rule.max });
    else if (rule.type === 'bool') out[key] = Boolean(raw);
    else if (rule.type === 'fnlist') {
      if (!Array.isArray(raw)) throw errors.validation('disabledFunctions 必须是数组', 'settings.disabledFunctions');
      const list = raw.slice(0, 20).map((f) => String(f));
      if (list.some((f) => !/^[a-z_][a-z0-9_]*$/i.test(f))) {
        throw errors.validation('函数名不合法', 'settings.disabledFunctions');
      }
      out[key] = [...new Set(list)];
    }
  }
  return out;
}

function mapSite(row) {
  if (!row) return null;
  const settings = parseJson(row.settings, {});
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    aliases: parseJson(row.aliases, []),
    domains: [row.domain, ...parseJson(row.aliases, [])],
    rootPath: row.root_path,
    siteUser: row.site_user,
    appType: row.app_type,
    phpVersion: row.php_version,
    upstream: row.upstream,
    status: row.status,
    desiredState: row.desired_state,
    sslMode: row.ssl_mode,
    settings,
    remark: row.remark,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 附加字段（列表查询时 join 出来）
    certStatus: row.cert_status ?? undefined,
    certNotAfter: row.cert_not_after ?? undefined,
  };
}

export function listSites(query = {}) {
  const db = getDb();
  const { page, size, offset } = paging(query, { defaultSize: 20, maxSize: 200 });
  const where = [];
  const params = [];
  if (query.status && SITE_STATUS.includes(query.status)) {
    where.push('s.status = ?');
    params.push(query.status);
  }
  if (query.appType) { where.push('s.app_type = ?'); params.push(query.appType); }
  if (query.q) {
    where.push('(s.name LIKE ? OR s.slug LIKE ? OR s.domain LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.get(`SELECT COUNT(*) c FROM sites s ${clause}`, params).c);
  // 一个站点可能有多张有效证书；用相关子查询取最新一张，避免 JOIN 产生重复行。
  const rows = db.all(
    `SELECT s.*,
       (SELECT c.status FROM certificates c
         WHERE c.site_id = s.id AND c.status IN ('issued','expiring')
         ORDER BY c.id DESC LIMIT 1) AS cert_status,
       (SELECT c.not_after FROM certificates c
         WHERE c.site_id = s.id AND c.status IN ('issued','expiring')
         ORDER BY c.id DESC LIMIT 1) AS cert_not_after
     FROM sites s
     ${clause}
     ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { items: rows.map(mapSite), total, page, size };
}

export function getSite(id) {
  const row = getDb().get('SELECT * FROM sites WHERE id = ?', [id]);
  if (!row) throw errors.notFound('站点不存在');
  return mapSite(row);
}

export function findSiteBySlug(slug) {
  return mapSite(getDb().get('SELECT * FROM sites WHERE slug = ?', [slug]));
}

export function getSiteDetail(id) {
  const site = getSite(id);
  const db = getDb();
  const certs = db.all(
    `SELECT id, domain, alt_names as altNames, provider, status, not_before as notBefore,
            not_after as notAfter, auto_renew as autoRenew, issuer, last_error as lastError, updated_at as updatedAt
     FROM certificates WHERE site_id = ? ORDER BY id DESC`,
    [id],
  ).map((c) => ({ ...c, altNames: parseJson(c.altNames, []) }));

  const tasks = db.all(
    `SELECT id, type, title, status, progress, error, created_at as createdAt, finished_at as finishedAt
     FROM tasks WHERE target_type = 'site' AND target_id = ? ORDER BY created_at DESC LIMIT 10`,
    [String(id)],
  );
  return { ...site, certificates: certs, recentTasks: tasks };
}

function assertDomainAvailable(domains, excludeSiteId = null) {
  const db = getDb();
  for (const domain of domains) {
    const row =
      db.get('SELECT id, name FROM sites WHERE domain = ?', [domain]) ||
      db.get(
        'SELECT s.id, s.name FROM sites s, json_each(s.aliases) a WHERE a.value = ? LIMIT 1',
        [domain],
      );
    if (row && Number(row.id) !== Number(excludeSiteId)) {
      throw errors.conflict(`域名 ${domain} 已被站点「${row.name}」使用`, { field: 'domains', domain });
    }
  }
}

function assertPhpAvailable(phpVersion) {
  if (!phpVersion) return;
  const row = getDb().get(
    "SELECT id, status FROM runtimes WHERE kind = 'php' AND version = ?",
    [phpVersion],
  );
  if (!row) {
    throw errors.conflict(`PHP ${phpVersion} 尚未安装，请先在「网站环境」中安装`);
  }
  if (row.status !== 'active') {
    throw errors.conflict(`PHP ${phpVersion} 当前状态为 ${row.status}，无法使用`);
  }
}

function assertWebServerReady() {
  const row = getDb().get("SELECT status FROM runtimes WHERE kind = 'nginx' ORDER BY id DESC LIMIT 1");
  if (!row || row.status !== 'active') {
    if (config.isDev) {
      log.warn('开发模式下跳过 Nginx 就绪检查');
      return;
    }
    throw errors.conflict('尚未安装 Nginx，请先在「网站环境」完成一键安装');
  }
}

export function createSite(input, actor) {
  const db = getDb();
  assertWebServerReady();

  const name = assertString(input.name, { field: 'name', min: 1, max: 64 });
  const slug = assertSlug(input.slug || deriveSlug(name), 'slug');
  const domains = assertDomains(input.domains || input.domain, 'domains');
  const appType = assertEnum(
    input.appType || getSetting('site.defaultAppType', 'php'),
    ['php', 'static', 'proxy'],
    'appType',
  );
  const phpVersion = appType === 'php'
    ? assertPhpVersion(input.phpVersion || getSetting('site.defaultPhpVersion', '8.3'))
    : null;
  const upstream = appType === 'proxy' ? assertString(input.upstream, { field: 'upstream', min: 8, max: 200 }) : null;
  const sslMode = assertEnum(input.sslMode || 'none', ['none', 'acme', 'manual'], 'sslMode');
  const remark = input.remark ? assertString(input.remark, { field: 'remark', max: 200 }) : '';
  const settings = normalizeSettings({
    rewrite: getSetting('site.defaultRewrite', 'none'),
    ...(input.settings || {}),
  });

  if (db.get('SELECT id FROM sites WHERE slug = ?', [slug])) {
    throw errors.conflict(`站点标识 ${slug} 已存在`, { field: 'slug' });
  }
  assertDomainAvailable(domains);
  if (appType === 'php') assertPhpAvailable(phpVersion);

  const now = nowIso();
  const rootPath = siteRoot(slug);
  const user = siteUser(slug);

  const { id, task } = db.tx(() => {
    const res = db.run(
      `INSERT INTO sites (slug, name, domain, aliases, root_path, site_user, app_type, php_version,
        upstream, status, desired_state, ssl_mode, settings, remark, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'running', ?, ?, ?, ?, ?, ?)`,
      [slug, name, domains[0], JSON.stringify(domains.slice(1)), rootPath, user, appType, phpVersion,
        upstream, sslMode, JSON.stringify(settings), remark, actor?.id ?? null, now, now],
    );
    const siteId = Number(res.lastInsertRowid);
    const stmt = db.db.prepare(
      'INSERT INTO site_domains (site_id, domain, is_primary) VALUES (?, ?, ?)',
    );
    domains.forEach((d, i) => stmt.run(siteId, d, i === 0 ? 1 : 0));

    return {
      id: siteId,
      task: createTask({
        type: 'site.create',
        title: `创建站点 ${name}（${domains[0]}）`,
        targetType: 'site',
        targetId: String(siteId),
        payload: { siteId, sslMode },
        createdBy: actor?.id ?? null,
        priority: 3,
      }),
    };
  });

  log.info(`站点已创建 ${slug}`, { siteId: id, taskId: task.id });
  return { site: getSite(id), task };
}

function deriveSlug(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (base.length >= 3) return base;
  return `site-${Date.now().toString(36).slice(-5)}`;
}

export function updateSite(id, patch, actor) {
  const db = getDb();
  const current = getSite(id);
  if (current.status === 'deleting') throw errors.conflict('站点正在删除中，无法修改');

  const fields = [];
  const params = [];

  let domains = current.domains;
  if (patch.domains) {
    domains = assertDomains(patch.domains, 'domains');
    assertDomainAvailable(domains, id);
    fields.push('domain = ?', 'aliases = ?');
    params.push(domains[0], JSON.stringify(domains.slice(1)));
  } else if (patch.domain) {
    const d = assertDomains([patch.domain, ...current.aliases], 'domains');
    domains = d;
    fields.push('domain = ?', 'aliases = ?');
    params.push(d[0], JSON.stringify(d.slice(1)));
  }

  if (patch.name !== undefined) {
    fields.push('name = ?');
    params.push(assertString(patch.name, { field: 'name', min: 1, max: 64 }));
  }
  if (patch.remark !== undefined) {
    fields.push('remark = ?');
    params.push(assertString(String(patch.remark), { field: 'remark', max: 200 }));
  }
  if (patch.appType !== undefined) {
    const appType = assertEnum(patch.appType, ['php', 'static', 'proxy'], 'appType');
    fields.push('app_type = ?');
    params.push(appType);
    if (appType === 'php') {
      const v = assertPhpVersion(patch.phpVersion || current.phpVersion || '8.3');
      assertPhpAvailable(v);
      fields.push('php_version = ?');
      params.push(v);
    } else {
      fields.push('php_version = NULL');
    }
    if (appType === 'proxy') {
      const upstream = assertString(patch.upstream || current.upstream, { field: 'upstream', min: 8, max: 200 });
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(upstream)) {
        throw errors.validation('反向代理目标必须是本机地址，如 http://127.0.0.1:3000', 'upstream');
      }
      fields.push('upstream = ?');
      params.push(upstream);
    } else {
      fields.push('upstream = NULL');
    }
  } else if (patch.phpVersion !== undefined && current.appType === 'php') {
    const v = assertPhpVersion(patch.phpVersion);
    assertPhpAvailable(v);
    fields.push('php_version = ?');
    params.push(v);
  } else if (patch.upstream !== undefined && current.appType === 'proxy') {
    const upstream = assertString(patch.upstream, { field: 'upstream', min: 8, max: 200 });
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(upstream)) {
      throw errors.validation('反向代理目标必须是本机地址', 'upstream');
    }
    fields.push('upstream = ?');
    params.push(upstream);
  }

  if (patch.settings) {
    fields.push('settings = ?');
    params.push(JSON.stringify(normalizeSettings({ ...current.settings, ...patch.settings })));
  }
  if (patch.sslMode !== undefined) {
    fields.push('ssl_mode = ?');
    params.push(assertEnum(patch.sslMode, ['none', 'acme', 'manual'], 'sslMode'));
  }
  if (patch.status !== undefined) {
    const next = assertEnum(patch.status, ['active', 'stopped'], 'status');
    fields.push('desired_state = ?', 'status = ?');
    params.push(next === 'active' ? 'running' : 'stopped', 'pending');
  }

  if (!fields.length) return { site: current, task: null };

  fields.push('updated_at = ?', 'last_error = NULL');
  params.push(nowIso(), id);

  // 状态变更与任务入队必须原子化：任务冲突时回滚，避免站点卡在 pending。
  return db.tx(() => {
    db.run(`UPDATE sites SET ${fields.join(', ')} WHERE id = ?`, params);

    if (domains !== current.domains) {
      db.run('DELETE FROM site_domains WHERE site_id = ?', [id]);
      const stmt = db.db.prepare('INSERT INTO site_domains (site_id, domain, is_primary) VALUES (?, ?, ?)');
      domains.forEach((d, i) => stmt.run(id, d, i === 0 ? 1 : 0));
    }

    const task = createTask({
      type: 'site.apply',
      title: `应用配置 ${current.name}`,
      targetType: 'site',
      targetId: String(id),
      payload: { siteId: id },
      createdBy: actor?.id ?? null,
      priority: 4,
    });

    return { site: getSite(id), task };
  });
}

export function deleteSite(id, { keepFiles = true, backup = true } = {}, actor) {
  const site = getSite(id);
  if (site.status === 'deleting') throw errors.conflict('站点正在删除中');
  const db = getDb();

  // 任务冲突时连同 deleting 状态一起回滚，避免站点被永久锁死。
  return db.tx(() => {
    db.run('UPDATE sites SET status = ?, updated_at = ? WHERE id = ?', ['deleting', nowIso(), id]);
    const task = createTask({
      type: 'site.remove',
      title: `删除站点 ${site.name}`,
      targetType: 'site',
      targetId: String(id),
      payload: { siteId: id, keepFiles, backup, slug: site.slug },
      createdBy: actor?.id ?? null,
      priority: 2,
    });
    return { site: getSite(id), task };
  });
}

/** 组装给 agent 的站点规格（含证书信息） */
export function buildSpec(site, { cert = null, enabled } = {}) {
  const activeCert = cert || getDb().get(
    `SELECT * FROM certificates WHERE site_id = ? AND status IN ('issued','expiring') ORDER BY id DESC LIMIT 1`,
    [site.id],
  );
  const useSsl = Boolean(activeCert && activeCert.cert_path && activeCert.key_path);
  return {
    slug: site.slug,
    siteUser: site.siteUser,
    domains: site.domains,
    rootPath: site.rootPath,
    appType: site.appType,
    phpVersion: site.phpVersion,
    phpSocket: phpSocketPath(site.slug),
    upstream: site.upstream,
    enabled: enabled ?? site.desiredState === 'running',
    ssl: useSsl
      ? {
          enabled: true,
          certPath: activeCert.fullchain_path || activeCert.cert_path,
          keyPath: activeCert.key_path,
          forceHttps: site.settings?.forceHttps !== false,
        }
      : { enabled: false },
    settings: site.settings,
  };
}

/** 生成配置预览文本（与 agent 落盘使用同一份渲染器，所见即所得） */
export function previewConfig(siteId) {
  const site = getSite(siteId);
  const spec = buildSpec(site);
  const vhost = renderSiteVhost(spec);
  const pool = spec.appType === 'php' ? renderPhpPool(spec) : null;
  return { spec, vhost, pool };
}

export function siteStats() {
  const db = getDb();
  const rows = db.all('SELECT status, COUNT(*) c FROM sites GROUP BY status');
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const withCert = Number(db.get(
    "SELECT COUNT(DISTINCT site_id) c FROM certificates WHERE status IN ('issued','expiring')",
  ).c);
  return { total, byStatus, withCert, withoutCert: Math.max(0, total - withCert) };
}
