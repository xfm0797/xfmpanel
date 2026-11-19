/**
 * 任务处理器：把 agent 的原子操作编排成完整业务流程。
 *
 * 约定：
 *  - 每个 handler 接收 ctx（log/progress/signal），返回结果对象（落 tasks.result）；
 *  - 失败必须把对象状态改成可观察的 error/failed，并留下 last_error；
 *  - 不在这里写审计（路由层在入队时已记录“谁发起了什么”），任务结果由 task_events 承载。
 */

import { getDb, nowIso, parseJson } from '../db/index.js';
import { callAgent } from './agent.js';
import { getSite, buildSpec } from './sites.js';
import { getSetting } from '../db/seed.js';
import { raise, resolve } from './alerts.js';
import { daysLeft } from './certs.js';
import { PATHS, siteRoot } from '../../../shared/paths.js';
import { renderSiteVhost, certPathsFor } from '../../../shared/render/nginx.js';
import { renderPhpPool } from '../../../shared/render/php-pool.js';
import { createLogger } from '../lib/logger.js';
import { config } from '../config.js';

const log = createLogger('handler');

function agentHooks(ctx) {
  return {
    onLog: (level, message) => ctx.log(level, message),
    onProgress: (pct, message) => ctx.progress(pct, message),
    signal: ctx.signal,
  };
}

function markSiteError(siteId, message) {
  getDb().run('UPDATE sites SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', [
    'error', String(message).slice(0, 1000), nowIso(), siteId,
  ]);
}

async function applySiteConfig(ctx, site, { cert = null } = {}) {
  const spec = buildSpec(site, { cert });
  // 先本地渲染一遍：渲染阶段就能拦下非法配置，避免无谓的远程执行
  const vhost = renderSiteVhost(spec);
  const pool = spec.appType === 'php' ? renderPhpPool(spec) : null;
  const res = await callAgent('site.apply', { spec }, agentHooks(ctx));
  return { ...res, vhostLength: vhost.length, poolLength: pool?.length ?? 0 };
}

async function ensureCertificate(ctx, site, domains, { force = false } = {}) {
  const email = getSetting('cert.email', '');
  const db = getDb();

  if (!email) {
    ctx.log('warn', '未配置 ACME 联系邮箱，建议在「设置」中填写，便于证书到期提醒');
  }

  try {
    const dnsRes = await callAgent('dns.check', { domain: domains[0] }, { timeoutMs: 8000 });
    if (dnsRes && dnsRes.resolved === false) {
      ctx.log('warn', `域名 ${domains[0]} 暂未解析出 A 记录，签发可能失败（HTTP-01 校验需要域名指向本机）`);
    } else {
      ctx.log('info', `域名解析检查通过：${(dnsRes.a || []).join(', ')}`);
    }
  } catch (err) {
    ctx.log('warn', `域名解析检查跳过：${err.message}`);
  }

  ctx.log('info', `向 ACME 申请证书：${domains.join(', ')}`);

  // 证书意图先行落库：即使签发失败，也能在证书页看到失败原因并重试
  let certRow = db.get(
    'SELECT * FROM certificates WHERE site_id = ? AND domain = ?',
    [site.id, domains[0]],
  );
  if (!certRow) {
    const res = db.run(
      `INSERT INTO certificates (site_id, domain, alt_names, provider, status, auto_renew, created_at, updated_at)
       VALUES (?, ?, ?, 'acme', 'pending', 1, ?, ?)`,
      [site.id, domains[0], JSON.stringify(domains.slice(1)), nowIso(), nowIso()],
    );
    certRow = db.get('SELECT * FROM certificates WHERE id = ?', [res.lastInsertRowid]);
  } else {
    db.run("UPDATE certificates SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?", [
      nowIso(), certRow.id,
    ]);
  }

  const issued = await callAgent('cert.issue', {
    slug: site.slug,
    domains,
    email,
    webroot: `${siteRoot(site.slug)}/public`,
    force,
  }, agentHooks(ctx));

  db.run(
    `UPDATE certificates SET status = 'issued', cert_path = ?, key_path = ?, fullchain_path = ?,
       issuer = ?, not_before = ?, not_after = ?, last_renew_at = ?, renew_attempts = 0,
       last_error = NULL, updated_at = ?
     WHERE id = ?`,
    [
      issued.certPath, issued.keyPath, issued.fullchainPath || issued.certPath,
      issued.issuer || 'ACME', issued.notBefore || nowIso(), issued.notAfter,
      nowIso(), nowIso(), certRow.id,
    ],
  );
  db.run("UPDATE sites SET ssl_mode = 'acme', updated_at = ? WHERE id = ?", [nowIso(), site.id]);
  resolve('cert', 'CERT_EXPIRED', `cert:${certRow.id}`);
  resolve('cert', 'CERT_EXPIRING', `cert:${certRow.id}`);
  ctx.log('success', `证书已签发，有效期至 ${String(issued.notAfter).slice(0, 10)}`);
  return db.get('SELECT * FROM certificates WHERE id = ?', [certRow.id]);
}

export const handlers = {
  // ---------------------------------------------------------------- 运行时
  'runtime.install': async (ctx) => {
    const { kind, version } = ctx.task.payload;
    const db = getDb();
    ctx.log('info', `准备安装 ${kind} ${version}，正在检测系统环境`);
    try {
      const info = await callAgent('system.info', {}, { timeoutMs: 10000 });
      ctx.log('info', `系统：${info.distro || info.os} / ${info.arch}，内存 ${info.memTotalMb}MB，磁盘剩余 ${info.disk?.totalGb - info.disk?.usedGb}GB`);
    } catch (err) {
      ctx.log('warn', `系统信息获取失败：${err.message}`);
    }

    try {
      const result = await callAgent('runtime.install', { kind, version }, agentHooks(ctx));

      db.run(
        `UPDATE runtimes SET status = 'active', service_name = ?, install_path = ?, config_path = ?,
           installed_at = ?, last_error = NULL, meta = ?, updated_at = ?
         WHERE kind = ? AND version = ?`,
        [
          result.serviceName || null,
          result.installPath || null,
          result.configPath || null,
          nowIso(),
          JSON.stringify({ installedLog: result.log?.slice?.(0, 20) ?? [] }),
          nowIso(),
          kind,
          version,
        ],
      );

      const hasDefault = db.get('SELECT id FROM runtimes WHERE kind = ? AND is_default = 1', [kind]);
      if (!hasDefault) {
        db.run('UPDATE runtimes SET is_default = 1 WHERE kind = ? AND version = ?', [kind, version]);
        ctx.log('info', `已将 ${kind} ${version} 设为该组件默认版本`);
      }
      resolve('runtime', 'INSTALL_FAILED', `runtime:${kind}:${version}`);
      ctx.log('success', `${kind} ${version} 安装完成`);
      return result;
    } catch (err) {
      // 失败必须离开 installing，否则用户无法重试。
      db.run(
        "UPDATE runtimes SET status = 'failed', last_error = ?, updated_at = ? WHERE kind = ? AND version = ?",
        [String(err.message).slice(0, 1000), nowIso(), kind, version],
      );
      raise({
        level: 'critical',
        source: 'runtime',
        code: 'INSTALL_FAILED',
        title: `安装失败：${kind} ${version}`,
        message: err.message,
        resource: `runtime:${kind}:${version}`,
        dedupeKey: `runtime:install_failed:${kind}:${version}`,
      });
      throw err;
    }
  },

  'runtime.remove': async (ctx) => {
    const { runtimeId, kind, version, serviceName } = ctx.task.payload;
    await callAgent('runtime.remove', { kind, version, serviceName }, agentHooks(ctx));
    getDb().run('DELETE FROM runtimes WHERE id = ?', [runtimeId]);
    const fallback = getDb().get(
      "SELECT id FROM runtimes WHERE kind = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
      [kind],
    );
    if (fallback) {
      getDb().run('UPDATE runtimes SET is_default = 1 WHERE id = ?', [fallback.id]);
    }
    return { removed: true };
  },

  // ---------------------------------------------------------------- 站点
  'site.create': async (ctx) => {
    const { siteId } = ctx.task.payload;
    const site = getSite(siteId);
    ctx.log('info', `站点目录：${site.rootPath}，系统用户：${site.siteUser}`);
    ctx.log('info', `应用类型：${site.appType}${site.phpVersion ? `，PHP ${site.phpVersion}` : ''}`);

    const applied = await (async () => {
      try {
        return await applySiteConfig(ctx, site);
      } catch (err) {
        markSiteError(siteId, err.message);
        raise({
          level: 'critical',
          source: 'site',
          code: 'CREATE_FAILED',
          title: `站点创建失败：${site.name}`,
          message: err.message,
          resource: `site:${siteId}`,
          dedupeKey: `site:create_failed:${siteId}`,
        });
        throw err;
      }
    })();
    getDb().run(
      "UPDATE sites SET status = 'active', last_error = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), siteId],
    );

    if (site.sslMode === 'acme') {
      ctx.log('info', '站点已创建，开始申请 SSL 证书');
      try {
        const cert = await ensureCertificate(ctx, site, site.domains, { force: false });
        await applySiteConfig(ctx, site, { cert });
        ctx.log('success', 'HTTPS 已启用');
      } catch (err) {
        ctx.log('error', `证书申请失败：${err.message}。站点 HTTP 访问不受影响，可在「SSL 证书」页重试`);
        raise({
          level: 'warning',
          source: 'cert',
          code: 'CERT_ISSUE_FAILED',
          title: `证书申请失败：${site.domain}`,
          message: err.message,
          resource: `site:${site.id}`,
          dedupeKey: `cert:issue_failed:${site.id}`,
        });
      }
    }

    ctx.log('success', '站点创建完成');
    return { vhostPath: applied.vhostPath, poolPath: applied.poolPath };
  },

  'site.apply': async (ctx) => {
    const { siteId } = ctx.task.payload;
    const site = getSite(siteId);
    try {
      const res = await applySiteConfig(ctx, site);
      const nextStatus = site.desiredState === 'running' ? 'active' : 'stopped';
      getDb().run('UPDATE sites SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?', [
        nextStatus, nowIso(), siteId,
      ]);
      resolve('site', 'APPLY_FAILED', `site:${siteId}`);
      ctx.log('success', nextStatus === 'active' ? '站点配置已生效' : '站点已停用（vhost 已移除）');
      return res;
    } catch (err) {
      markSiteError(siteId, err.message);
      raise({
        level: 'critical',
        source: 'site',
        code: 'APPLY_FAILED',
        title: `站点配置应用失败：${site.name}`,
        message: err.message,
        resource: `site:${siteId}`,
        dedupeKey: `site:apply_failed:${siteId}`,
      });
      throw err;
    }
  },

  'site.remove': async (ctx) => {
    const { siteId, backup, keepFiles } = ctx.task.payload;
    const site = getSite(siteId);
    const db = getDb();

    if (backup) {
      try {
        const res = await callAgent('site.backup', { slug: site.slug, root: site.rootPath }, agentHooks(ctx));
        db.run('INSERT INTO backups (site_id, path, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?)', [
          siteId, res.path, Number(res.sizeBytes) || 0, 'success', nowIso(),
        ]);
        ctx.log('info', `已备份到 ${res.path}`);
      } catch (err) {
        ctx.log('warn', `备份失败（继续删除配置）：${err.message}`);
      }
    }

    try {
      await callAgent('site.remove', { slug: site.slug, siteUser: site.siteUser, keepFiles }, agentHooks(ctx));

      db.tx(() => {
        db.run('DELETE FROM certificates WHERE site_id = ?', [siteId]);
        db.run('DELETE FROM site_domains WHERE site_id = ?', [siteId]);
        db.run('DELETE FROM sites WHERE id = ?', [siteId]);
      });
    } catch (err) {
      // 删除失败必须离开 deleting，否则站点会被永久锁死且无法重试。
      markSiteError(siteId, err.message);
      throw err;
    }
    ctx.log('success', keepFiles ? '站点已删除，站点文件保留在磁盘' : '站点已删除，文件已清理');
    return { removed: true, keepFiles };
  },

  'site.action': async (ctx) => {
    const { siteId, action } = ctx.task.payload;
    const site = getSite(siteId);
    if (action === 'reload') {
      await callAgent('service.action', { unit: 'nginx', action: 'reload' }, agentHooks(ctx));
      if (site.appType === 'php' && site.phpVersion) {
        try {
          await callAgent('service.action', { unit: `php${site.phpVersion}-fpm`, action: 'reload' }, agentHooks(ctx));
        } catch (err) {
          ctx.log('warn', `PHP-FPM 重载失败：${err.message}`);
        }
      }
      ctx.log('success', '服务已重载');
      return { action };
    }
    throw new Error(`不支持的站点动作：${action}`);
  },

  // ---------------------------------------------------------------- 证书
  'cert.issue': async (ctx) => {
    const { certId, siteId, domains, force } = ctx.task.payload;
    const site = getSite(siteId);
    try {
      const cert = await ensureCertificate(ctx, site, domains, { force });
      await applySiteConfig(ctx, site, { cert });
      getDb().run("UPDATE sites SET status = 'active', last_error = NULL, updated_at = ? WHERE id = ?", [
        nowIso(), siteId,
      ]);
      ctx.log('success', '证书部署完成，HTTPS 已生效');
      return { certId, notAfter: cert.not_after };
    } catch (err) {
      getDb().run(
        "UPDATE certificates SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
        [String(err.message).slice(0, 1000), nowIso(), certId],
      );
      raise({
        level: 'warning',
        source: 'cert',
        code: 'CERT_ISSUE_FAILED',
        title: `证书申请失败：${site.domain}`,
        message: err.message,
        resource: `site:${site.id}`,
        dedupeKey: `cert:issue_failed:${site.id}`,
      });
      throw err;
    }
  },

  'cert.renew': async (ctx) => {
    const { certId, siteId, domains, auto } = ctx.task.payload;
    const db = getDb();
    const site = getSite(siteId);
    try {
      ctx.log('info', `${auto ? '自动' : '手动'}续期：${domains.join(', ')}`);
      const email = getSetting('cert.email', '');
      const issued = await callAgent('cert.renew', {
        slug: site.slug,
        domains,
        email,
        webroot: `${siteRoot(site.slug)}/public`,
        // 手动续期强制重签；自动续期交给 certbot 判断是否临近到期，避免触发频率限制。
        force: !auto,
      }, agentHooks(ctx));

      db.run(
        `UPDATE certificates SET status = 'issued', cert_path = ?, key_path = ?, fullchain_path = ?,
           not_before = ?, not_after = ?, last_renew_at = ?, renew_attempts = 0, last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [
          issued.certPath, issued.keyPath, issued.fullchainPath || issued.certPath,
          issued.notBefore || nowIso(), issued.notAfter, nowIso(), nowIso(), certId,
        ],
      );

      const cert = db.get('SELECT * FROM certificates WHERE id = ?', [certId]);
      await applySiteConfig(ctx, site, { cert });

      resolve('cert', 'CERT_EXPIRING', `cert:${certId}`);
      resolve('cert', 'CERT_EXPIRED', `cert:${certId}`);
      const left = daysLeft(issued.notAfter);
      ctx.log('success', `续期成功，新有效期至 ${String(issued.notAfter).slice(0, 10)}（${left} 天）`);
      return { certId, notAfter: issued.notAfter, daysLeft: left };
    } catch (err) {
      db.run(
        `UPDATE certificates SET status = CASE WHEN status = 'issued' THEN 'expiring' ELSE status END,
           renew_attempts = renew_attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        [String(err.message).slice(0, 1000), nowIso(), certId],
      );
      raise({
        level: 'critical',
        source: 'cert',
        code: 'CERT_RENEW_FAILED',
        title: `证书续期失败：${site.domain}`,
        message: `${err.message}（已尝试 ${auto ? '自动' : '手动'}续期，请尽快处理，过期后 HTTPS 将不可用）`,
        resource: `cert:${certId}`,
        dedupeKey: `cert:renew_failed:${certId}`,
      });
      throw err;
    }
  },

  'cert.revoke': async (ctx) => {
    const { certId, siteId, domain } = ctx.task.payload;
    const db = getDb();
    const site = getSite(siteId);
    const cert = db.get('SELECT provider FROM certificates WHERE id = ?', [certId]);
    if (cert?.provider === 'upload') {
      // 本地上传证书没有 ACME 记录，无需（也不应）调用 certbot 做吊销。
      ctx.log('info', '本地上传证书无 ACME 记录，跳过 certbot 吊销');
    } else {
      await callAgent('cert.revoke', { slug: site.slug, domain, certPath: null }, agentHooks(ctx));
    }
    db.run("UPDATE certificates SET status = 'revoked', auto_renew = 0, updated_at = ? WHERE id = ?", [
      nowIso(), certId,
    ]);
    db.run("UPDATE sites SET ssl_mode = 'none', updated_at = ? WHERE id = ?", [nowIso(), siteId]);
    // 证书吊销后立即回退到 HTTP，避免 nginx 引用已删除的证书文件
    const fresh = getSite(siteId);
    await applySiteConfig(ctx, fresh, { cert: null });
    ctx.log('success', '证书已吊销，站点已回退到 HTTP');
    return { revoked: true };
  },

  'cert.upload': async (ctx) => {
    const { certId, siteId, slug, domain, certPem, keyPem, chainPem } = ctx.task.payload;
    const db = getDb();
    const site = getSite(siteId);
    try {
      const res = await callAgent('cert.upload', { slug, domain, certPem, keyPem, chainPem }, agentHooks(ctx));

      let notAfter = null;
      let issuer = '手动上传';
      try {
        const info = await callAgent('cert.inspect', { certPath: res.certPath }, { timeoutMs: 10000 });
        notAfter = info.notAfter;
        issuer = info.issuer || issuer;
      } catch (err) {
        ctx.log('warn', `证书解析失败：${err.message}`);
      }

      db.run(
        `UPDATE certificates SET status = 'issued', provider = 'upload', cert_path = ?, key_path = ?,
           fullchain_path = ?, not_after = ?, issuer = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [res.certPath, res.keyPath, res.fullchainPath || res.certPath, notAfter, issuer, nowIso(), certId],
      );

      const cert = db.get('SELECT * FROM certificates WHERE id = ?', [certId]);
      await applySiteConfig(ctx, site, { cert });
      ctx.log('success', '证书已部署，HTTPS 已生效');
      return { certId, notAfter };
    } catch (err) {
      db.run(
        "UPDATE certificates SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
        [String(err.message).slice(0, 1000), nowIso(), certId],
      );
      throw err;
    }
  },
};

/** 供路由层做参数/依赖自检 */
export function handlerExists(type) {
  return Boolean(handlers[type]);
}

export const handlerMeta = {
  paths: PATHS,
  devMode: config.isDev,
  renderers: { renderSiteVhost, renderPhpPool, certPathsFor, parseJson },
};
