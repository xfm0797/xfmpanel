/**
 * 证书服务：申请 / 续期 / 吊销 / 上传 / 状态巡检。
 *
 * 状态机：pending --签发成功--> issued --临近到期--> expiring --过期--> expired
 *         失败 -> failed（保留错误原因，可重试）
 */

import { getDb, nowIso, parseJson } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { createTask } from './tasks.js';
import { getSite } from './sites.js';
import { raise, resolve } from './alerts.js';
import { getSetting } from '../db/seed.js';
import { config } from '../config.js';
import { assertDomains } from '../../../shared/validate.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('certs');

const CERT_TASK_TYPES = ['cert.issue', 'cert.upload', 'cert.renew', 'cert.revoke'];

/** 同一站点的所有证书任务互斥，避免签发/续期/吊销并发改写同一份证书与 vhost */
function assertNoCertTask(siteId) {
  const placeholders = CERT_TASK_TYPES.map(() => '?').join(',');
  const row = getDb().get(
    `SELECT id FROM tasks WHERE target_type = 'site' AND target_id = ?
       AND type IN (${placeholders}) AND status IN ('queued','running')`,
    [String(siteId), ...CERT_TASK_TYPES],
  );
  if (row) throw errors.taskConflict('该站点已有进行中的证书任务');
}

export function daysLeft(notAfter) {
  if (!notAfter) return null;
  return Math.floor((new Date(notAfter).getTime() - Date.now()) / 86400000);
}

export function listCertificates(query = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (query.status) { where.push('c.status = ?'); params.push(query.status); }
  if (query.siteId) { where.push('c.site_id = ?'); params.push(Number(query.siteId)); }
  if (query.q) { where.push('(c.domain LIKE ? OR s.name LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT c.*, s.name AS site_name, s.slug AS site_slug
     FROM certificates c LEFT JOIN sites s ON s.id = c.site_id
     ${clause} ORDER BY c.id DESC LIMIT 200`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    siteName: r.site_name,
    siteSlug: r.site_slug,
    domain: r.domain,
    altNames: parseJson(r.alt_names, []),
    provider: r.provider,
    status: r.status,
    certPath: r.cert_path,
    keyPath: r.key_path,
    issuer: r.issuer,
    notBefore: r.not_before,
    notAfter: r.not_after,
    daysLeft: daysLeft(r.not_after),
    autoRenew: Number(r.auto_renew) === 1,
    lastRenewAt: r.last_renew_at,
    renewAttempts: r.renew_attempts,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  }));
}

export function getCertificate(id) {
  const row = getDb().get('SELECT * FROM certificates WHERE id = ?', [id]);
  if (!row) throw errors.notFound('证书不存在');
  return row;
}

export function issueCertificate({ siteId, domains, force = false }, actor) {
  const site = getSite(siteId);
  const list = domains ? assertDomains(domains) : site.domains;
  const db = getDb();

  assertNoCertTask(siteId);

  const existing = db.get(
    'SELECT * FROM certificates WHERE site_id = ? AND domain = ?',
    [siteId, list[0]],
  );
  if (existing && existing.status === 'issued' && !force) {
    throw errors.conflict('该域名已有有效证书，如需重新签发请勾选强制重签');
  }

  const now = nowIso();
  // 证书意图与任务入队原子化：冲突时回滚，避免证书停在 pending。
  const { task, certId } = db.tx(() => {
    let id;
    if (existing) {
      db.run(
        `UPDATE certificates SET alt_names = ?, provider = 'acme', status = 'pending', last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(list.slice(1)), now, existing.id],
      );
      id = existing.id;
    } else {
      const res = db.run(
        `INSERT INTO certificates (site_id, domain, alt_names, provider, status, auto_renew, created_at, updated_at)
         VALUES (?, ?, ?, 'acme', 'pending', 1, ?, ?)`,
        [siteId, list[0], JSON.stringify(list.slice(1)), now, now],
      );
      id = Number(res.lastInsertRowid);
    }

    db.run("UPDATE sites SET ssl_mode = 'acme', updated_at = ? WHERE id = ?", [now, siteId]);

    const created = createTask({
      type: 'cert.issue',
      title: `申请证书 ${list.join(', ')}`,
      targetType: 'site',
      targetId: String(siteId),
      payload: { certId: id, siteId, domains: list, force },
      createdBy: actor?.id ?? null,
      priority: 3,
    });
    return { task: created, certId: id };
  });

  log.info(`创建证书申请任务 ${task.id}`, { siteId, domains: list });
  return { task, certId };
}

export function renewCertificate(id, actor, { auto = false } = {}) {
  const cert = getCertificate(id);
  if (cert.status === 'revoked') throw errors.conflict('证书已吊销，无法续期');
  // 上传证书不受 certbot 管理，续期必然失败，直接给出明确指引
  if (cert.provider !== 'acme') throw errors.conflict('该证书为手动上传，无法自动续期，请重新上传新证书');
  assertNoCertTask(cert.site_id);

  const task = createTask({
    type: 'cert.renew',
    title: `续期证书 ${cert.domain}`,
    targetType: 'site',
    targetId: String(cert.site_id),
    payload: { certId: id, siteId: cert.site_id, domains: [cert.domain, ...parseJson(cert.alt_names, [])], auto },
    createdBy: actor?.id ?? null,
    priority: auto ? 2 : 4,
  });
  return { task };
}

export function revokeCertificate(id, actor) {
  const cert = getCertificate(id);
  if (cert.status === 'revoked') throw errors.conflict('证书已经是吊销状态');
  assertNoCertTask(cert.site_id);
  const task = createTask({
    type: 'cert.revoke',
    title: `吊销证书 ${cert.domain}`,
    targetType: 'site',
    targetId: String(cert.site_id),
    payload: { certId: id, siteId: cert.site_id, domain: cert.domain },
    createdBy: actor?.id ?? null,
    priority: 4,
  });
  return { task };
}

export function uploadCertificate({ siteId, domain, certPem, keyPem, chainPem = '' }, actor) {
  const site = getSite(siteId);
  if (!certPem.includes('BEGIN CERTIFICATE') || !keyPem.includes('PRIVATE KEY')) {
    throw errors.validation('证书或私钥格式不正确（需 PEM 格式）', 'certPem');
  }
  if (chainPem && !chainPem.includes('BEGIN CERTIFICATE')) {
    throw errors.validation('中间证书链格式不正确（需 PEM 格式）', 'chainPem');
  }
  if (certPem.length > 200_000 || keyPem.length > 200_000 || chainPem.length > 200_000) {
    throw errors.validation('证书内容过大', 'certPem');
  }
  assertNoCertTask(siteId);
  const db = getDb();
  const target = domain ? assertDomains([domain], 'domain')[0] : site.domain;
  if (!site.domains.includes(target)) {
    throw errors.validation('证书域名必须属于该站点，请先添加域名', 'domain');
  }
  const existing = db.get('SELECT * FROM certificates WHERE site_id = ? AND domain = ?', [siteId, target]);
  const now = nowIso();

  // 与证书申请一致：状态变更和任务入队必须原子化。
  const { task, certId } = db.tx(() => {
    let id;
    if (existing) {
      db.run("UPDATE certificates SET provider = 'upload', status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?", [now, existing.id]);
      id = existing.id;
    } else {
      const res = db.run(
        `INSERT INTO certificates (site_id, domain, provider, status, auto_renew, created_at, updated_at)
         VALUES (?, ?, 'upload', 'pending', 0, ?, ?)`,
        [siteId, target, now, now],
      );
      id = Number(res.lastInsertRowid);
    }
    db.run("UPDATE sites SET ssl_mode = 'manual', updated_at = ? WHERE id = ?", [now, siteId]);

    const created = createTask({
      type: 'cert.upload',
      title: `上传证书 ${target}`,
      targetType: 'site',
      targetId: String(siteId),
      payload: { certId: id, siteId, slug: site.slug, domain: target, certPem, keyPem, chainPem },
      createdBy: actor?.id ?? null,
      priority: 3,
    });
    return { task: created, certId: id };
  });
  return { task, certId };
}

/**
 * 状态巡检：把 issued/expiring/expired 与 not_after 对齐，并产生告警。
 * 由定时器每 6 小时调用一次，也可手动触发。
 */
export function refreshCertificateStatuses() {
  const db = getDb();
  const rows = db.all("SELECT * FROM certificates WHERE status IN ('issued','expiring','expired')");
  const warnDays = Number(getSetting('cert.renewBeforeDays', config.certRenewBeforeDays));
  const expiringWarn = config.certExpiringWarnDays;
  let changed = 0;

  for (const row of rows) {
    const left = daysLeft(row.not_after);
    if (left === null) continue;
    let next = row.status;
    if (left < 0) next = 'expired';
    else if (left <= warnDays) next = 'expiring';
    else next = 'issued';

    if (next !== row.status) {
      db.run('UPDATE certificates SET status = ?, updated_at = ? WHERE id = ?', [next, nowIso(), row.id]);
      changed += 1;
    }

    if (next === 'expired') {
      raise({
        level: 'critical',
        source: 'cert',
        code: 'CERT_EXPIRED',
        title: `证书已过期：${row.domain}`,
        message: `证书于 ${row.not_after?.slice(0, 10)} 过期，站点 HTTPS 将不可访问`,
        resource: `cert:${row.id}`,
        dedupeKey: `cert:expired:${row.id}`,
      });
    } else if (next === 'expiring' && left <= expiringWarn) {
      raise({
        level: 'warning',
        source: 'cert',
        code: 'CERT_EXPIRING',
        title: `证书即将过期：${row.domain}`,
        message: `剩余 ${left} 天${Number(row.auto_renew) === 1 ? '，将自动续期' : '，自动续期已关闭'}`,
        resource: `cert:${row.id}`,
        dedupeKey: `cert:expiring:${row.id}`,
      });
    } else {
      resolve('cert', 'CERT_EXPIRED', `cert:${row.id}`);
      if (left > expiringWarn) resolve('cert', 'CERT_EXPIRING', `cert:${row.id}`);
    }

    db.run('INSERT INTO cert_checks (cert_id, checked_at, days_left, action) VALUES (?, ?, ?, ?)', [
      row.id, nowIso(), left, next,
    ]);
  }
  return { checked: rows.length, changed };
}

/** 自动续期：剩余天数小于阈值且开启自动续期的证书入队 */
export function scheduleRenewals() {
  // 自动续期总开关：关闭后仍可手动续期，但巡检不再自动入队。
  if (String(getSetting('cert.autoRenew', 'true')).toLowerCase() === 'false') {
    return { scanned: 0, queued: [], disabled: true };
  }
  const db = getDb();
  const threshold = Number(getSetting('cert.renewBeforeDays', config.certRenewBeforeDays));
  const rows = db.all(
    `SELECT * FROM certificates WHERE auto_renew = 1 AND status IN ('issued','expiring')
     AND provider = 'acme' AND not_after IS NOT NULL`,
  );
  const queued = [];
  for (const row of rows) {
    const left = daysLeft(row.not_after);
    if (left === null || left > threshold) continue;
    const placeholders = CERT_TASK_TYPES.map(() => '?').join(',');
    const busy = db.get(
      `SELECT id FROM tasks WHERE target_type = 'site' AND target_id = ?
         AND type IN (${placeholders}) AND status IN ('queued','running')`,
      [String(row.site_id), ...CERT_TASK_TYPES],
    );
    if (busy) continue;
    try {
      renewCertificate(row.id, null, { auto: true });
      queued.push(row.id);
    } catch (err) {
      log.warn(`自动续期入队失败 cert=${row.id}`, { message: err.message });
    }
  }
  if (queued.length) log.info(`自动续期已入队 ${queued.length} 个证书`);
  return { scanned: rows.length, queued };
}

/** 清理历史巡检记录，避免 cert_checks 无限增长 */
export function cleanupCertChecks() {
  const cutoff = new Date(Date.now() - config.certCheckRetentionDays * 86400 * 1000).toISOString();
  return getDb().run('DELETE FROM cert_checks WHERE checked_at < ?', [cutoff]).changes;
}

export function certStats() {
  const db = getDb();
  const rows = db.all('SELECT status, COUNT(*) c FROM certificates GROUP BY status');
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.c)]));
  const soon = db.all(
    `SELECT id, domain, not_after as notAfter, status, auto_renew as autoRenew FROM certificates
     WHERE status IN ('issued','expiring') AND not_after IS NOT NULL
     ORDER BY not_after ASC LIMIT 10`,
  ).map((r) => ({ ...r, daysLeft: daysLeft(r.notAfter), autoRenew: Number(r.autoRenew) === 1 }));
  return { byStatus, soon, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
}
