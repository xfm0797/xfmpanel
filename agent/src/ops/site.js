/**
 * 站点原子操作：创建系统用户/目录 → 渲染配置 → 写入 → nginx -t → 重载。
 *
 * 关键安全设计：
 *  - 站点根目录必须严格等于 /www/xfm/<slug>，agent 不接受任意路径；
 *  - 配置内容由 shared/render 生成（面板预览与实际落盘同源），不接受原始配置文本；
 *  - nginx -t 失败时回滚到上一次的 vhost，绝不把坏配置留在磁盘上；
 *  - 删除文件前做前缀校验 + realpath 复核。
 */

import fs from 'node:fs';
import path from 'node:path';
import { run, runCapture } from '../lib/exec.js';
import {
  assertWithin, assertRealWithin, ensureDir, writeAtomic, readIfExists,
  removeIfExists, ensureSymlink, readTail, dirUsage, resolveUid,
} from '../lib/fs-safe.js';
import { PATHS, siteRoot, siteLogDir, phpSocketPath, phpPoolPath } from '../../../shared/paths.js';
import { renderSiteVhost } from '../../../shared/render/nginx.js';
import { renderPhpPool } from '../../../shared/render/php-pool.js';
import {
  s, arr, oneOf, bool, absPath, obj, ArgError, SLUG_RE, DOMAIN_RE, USER_RE,
} from './args.js';

const CERT_PREFIXES = ['/etc/letsencrypt/live', '/etc/letsencrypt/archive', PATHS.CERT_ROOT];

function validateSsl(ssl, field) {
  if (!ssl || typeof ssl !== 'object') return { enabled: false };
  const enabled = bool(Boolean(ssl.enabled), `${field}.enabled`);
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    certPath: absPath(ssl.certPath, CERT_PREFIXES, `${field}.certPath`),
    keyPath: absPath(ssl.keyPath, CERT_PREFIXES, `${field}.keyPath`),
    forceHttps: ssl.forceHttps === undefined ? true : Boolean(ssl.forceHttps),
  };
}

function validateSettings(input = {}) {
  const raw = obj(input, 'settings');
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(Math.round(n), min), max);
  };
  return {
    rewrite: ['none', 'wordpress', 'laravel', 'thinkphp', 'discuz'].includes(raw.rewrite) ? raw.rewrite : 'none',
    clientMaxBodySizeMb: num(raw.clientMaxBodySizeMb, 64, 1, 4096),
    maxChildren: num(raw.maxChildren, 10, 2, 80),
    memoryLimitMb: num(raw.memoryLimitMb, 256, 32, 4096),
    maxExecutionTime: num(raw.maxExecutionTime, 120, 10, 900),
    uploadMaxFilesizeMb: num(raw.uploadMaxFilesizeMb, 64, 1, 2048),
    forceHttps: raw.forceHttps === undefined ? true : Boolean(raw.forceHttps),
    disabledFunctions: Array.isArray(raw.disabledFunctions)
      ? raw.disabledFunctions.slice(0, 20).filter((f) => typeof f === 'string' && /^[a-z_][a-z0-9_]*$/i.test(f))
      : [],
  };
}

export function validateSpec(input) {
  const spec = obj(input, 'spec');
  const slug = s(spec.slug, { field: 'slug', max: 32 });
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error('站点标识不合法'), { code: 'BAD_ARGS' });

  const siteUser = s(spec.siteUser, { field: 'siteUser', max: 32 });
  if (!USER_RE.test(siteUser) || siteUser !== `xfm_${slug}`.slice(0, 32)) {
    throw Object.assign(new Error('站点系统用户必须为 xfm_<slug>'), { code: 'BAD_ARGS' });
  }

  const domains = arr(spec.domains, { field: 'domains', max: 20 })
    .map((d) => s(d, { field: 'domains', max: 253 }).toLowerCase());
  if (!domains.length) throw Object.assign(new Error('至少需要一个域名'), { code: 'BAD_ARGS' });
  for (const d of domains) {
    if (!DOMAIN_RE.test(d)) throw Object.assign(new Error(`域名不合法：${d}`), { code: 'BAD_ARGS' });
  }

  const expectedRoot = siteRoot(slug);
  const rootPath = absPath(spec.rootPath, [PATHS.WWW_ROOT], 'rootPath').replace(/\/+$/, '');
  if (rootPath !== expectedRoot) {
    throw Object.assign(new Error(`站点目录必须是 ${expectedRoot}`), { code: 'BAD_ARGS' });
  }

  const appType = oneOf(spec.appType, ['php', 'static', 'proxy'], 'appType');
  let phpVersion = null;
  let phpSocket = null;
  if (appType === 'php') {
    phpVersion = s(spec.phpVersion, { field: 'phpVersion', max: 5, pattern: /^\d\.\d$/ });
    phpSocket = absPath(spec.phpSocket, [PATHS.PHP_RUN_DIR], 'phpSocket');
    if (phpSocket !== phpSocketPath(slug)) {
      throw Object.assign(new Error('PHP socket 路径不符合约定'), { code: 'BAD_ARGS' });
    }
  }

  let upstream = null;
  if (appType === 'proxy') {
    upstream = s(spec.upstream, { field: 'upstream', max: 200 });
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(upstream)) {
      throw Object.assign(new Error('反向代理目标必须是本机地址'), { code: 'BAD_ARGS' });
    }
  }

  return {
    slug,
    siteUser,
    domains,
    rootPath,
    appType,
    phpVersion,
    phpSocket,
    upstream,
    enabled: spec.enabled === undefined ? true : Boolean(spec.enabled),
    ssl: validateSsl(spec.ssl, 'ssl'),
    settings: validateSettings(spec.settings || {}),
  };
}

/** Debian 系用 sites-available/sites-enabled，RHEL 系退回 conf.d */
function nginxLayout() {
  if (fs.existsSync(PATHS.NGINX_AVAILABLE)) {
    return { available: PATHS.NGINX_AVAILABLE, enabled: PATHS.NGINX_ENABLED, useSymlink: true };
  }
  return { available: '/etc/nginx/conf.d', enabled: null, useSymlink: false };
}

async function ensureSiteUser(spec, emit) {
  const exists = await runCapture('getent', ['passwd', spec.siteUser], { timeout: 8000 });
  if (exists.ok) {
    emit.log('info', `系统用户 ${spec.siteUser} 已存在`);
    return Number((await runCapture('id', ['-u', spec.siteUser])).stdout);
  }
  await run('useradd', [
    '--system', '--no-create-home', '--home-dir', spec.rootPath,
    '--shell', '/usr/sbin/nologin', '--user-group', spec.siteUser,
  ], { timeout: 30_000 });
  emit.log('info', `已创建系统用户 ${spec.siteUser}（禁止登录 shell）`);
  const uid = await resolveUid(spec.siteUser);
  return uid;
}

async function ensureSiteDirs(spec, uid, emit) {
  const root = spec.rootPath;
  const dirs = [
    { p: root, mode: 0o755 },
    { p: `${root}/public`, mode: 0o755 },
    { p: `${root}/logs`, mode: 0o750 },
    { p: `${root}/tmp`, mode: 0o750 },
    { p: `${root}/backup`, mode: 0o700 },
    { p: `${root}/ssl`, mode: 0o700 },
  ];
  for (const d of dirs) {
    ensureDir(d.p, { mode: d.mode, uid, gid: uid });
  }
  // 站点根目录需对 nginx(www-data) 可读
  await run('chmod', ['755', root], { timeout: 5000, allowFailure: true });
  await run('chmod', ['755', `${root}/public`], { timeout: 5000, allowFailure: true });

  // 日志目录：站点用户 + www-data 组，双方都可写
  ensureDir(siteLogDir(spec.slug), { mode: 0o770 });
  const wwwGid = await runCapture('getent', ['group', 'www-data'], { timeout: 5000 });
  if (wwwGid.ok) {
    const gid = Number(wwwGid.stdout.split(':')[2]);
    try {
      fs.chownSync(siteLogDir(spec.slug), uid, gid);
      fs.chmodSync(siteLogDir(spec.slug), 0o770);
    } catch (err) {
      emit.log('warn', `日志目录权限设置失败：${err.message}`);
    }
  }

  // 默认首页（仅在 public 为空时创建，不覆盖用户文件）
  const indexFile = `${root}/public/index.php`;
  const htmlFile = `${root}/public/index.html`;
  if (!fs.existsSync(indexFile) && !fs.existsSync(htmlFile)) {
    if (spec.appType === 'php') {
      fs.writeFileSync(indexFile, [
        '<?php',
        '/**',
        ` * ${spec.domains[0]} 默认首页，由 XFMPanel 创建于 ${new Date().toISOString()}`,
        ' * 部署代码后可直接覆盖本文件。',
        ' */',
        "header('Content-Type: text/html; charset=utf-8');",
        `echo '<!doctype html><meta charset="utf-8"><title>站点已创建</title>';
echo '<div style="font-family:system-ui;padding:48px;line-height:1.7">';
echo '<h1>站点已就绪</h1>';
echo '<p>域名：${spec.domains[0]}</p>';
echo '<p>站点目录：<code>${root}/public</code></p>';
echo '<p>请将代码上传到该目录，或删除本文件后重新部署。</p>';
echo '</div>';`,
        '',
      ].join('\n'));
    } else {
      fs.writeFileSync(htmlFile, `<!doctype html><meta charset="utf-8"><title>${spec.domains[0]}</title><h1>站点已就绪</h1><p>${spec.domains[0]}</p>`);
    }
    try {
      fs.chownSync(spec.appType === 'php' ? indexFile : htmlFile, uid, uid);
    } catch { /* ignore */ }
    emit.log('info', `已生成默认首页（${root}/public）`);
  }
}

export async function applySiteConfig(spec, emit) {
  const layout = nginxLayout();
  const vhostPath = path.join(layout.available, `xfm-${spec.slug}.conf`);
  const linkPath = layout.useSymlink ? path.join(layout.enabled, `xfm-${spec.slug}.conf`) : null;

  // PHP 环境检查
  if (spec.appType === 'php') {
    const poolDir = path.dirname(phpPoolPath(spec.phpVersion, spec.slug));
    if (!fs.existsSync(poolDir)) {
      const err = new Error(`PHP ${spec.phpVersion} 未安装（缺少 ${poolDir}）`);
      err.code = 'PHP_NOT_INSTALLED';
      throw err;
    }
  }

  const vhost = renderSiteVhost(spec);
  const pool = spec.appType === 'php' ? renderPhpPool(spec) : null;
  const poolPath = spec.appType === 'php' ? phpPoolPath(spec.phpVersion, spec.slug) : null;

  const prevVhost = readIfExists(vhostPath);
  const prevLink = linkPath && fs.existsSync(linkPath);

  emit.progress(35, `写入 vhost ${vhostPath}`);
  writeAtomic(vhostPath, vhost, { mode: 0o644 });

  if (pool && poolPath) {
    emit.progress(55, `写入 PHP-FPM pool ${poolPath}`);
    writeAtomic(poolPath, pool, { mode: 0o644 });
  }

  if (linkPath) {
    if (spec.enabled) {
      ensureSymlink(vhostPath, linkPath);
      emit.log('info', '已启用站点（sites-enabled 软链已建立）');
    } else if (fs.existsSync(linkPath)) {
      fs.unlinkSync(linkPath);
      emit.log('info', '站点已停用（sites-enabled 软链已移除）');
    }
  }

  emit.progress(75, 'nginx -t 配置校验');
  const test = await runCapture('nginx', ['-t'], { timeout: 30_000 });
  if (!test.ok) {
    // 回滚
    if (prevVhost !== null) writeAtomic(vhostPath, prevVhost, { mode: 0o644 });
    else removeIfExists(vhostPath);
    if (linkPath && prevLink) ensureSymlink(vhostPath, linkPath);
    else if (linkPath && !prevLink) removeIfExists(linkPath);
    const err = new Error(`nginx 配置校验失败，已回滚：${(test.stderr || test.stdout).trim().slice(-600)}`);
    err.code = 'NGINX_TEST_FAILED';
    throw err;
  }
  emit.log('info', 'nginx -t 通过');

  emit.progress(88, '重载 nginx');
  await run('systemctl', ['reload', 'nginx'], { timeout: 60_000 });

  if (spec.appType === 'php' && spec.phpVersion) {
    emit.progress(94, `重载 php${spec.phpVersion}-fpm`);
    await run('systemctl', ['reload', `php${spec.phpVersion}-fpm`], { timeout: 60_000, allowFailure: true });
  }

  if (!spec.enabled) {
    emit.log('warn', '站点处于停用状态，nginx 不会转发该域名的请求');
  }

  return { vhostPath, poolPath, rendered: { vhost, pool } };
}

export const siteOps = {
  'site.provision': {
    validate: (args) => ({ spec: validateSpec(args.spec) }),
    run: async ({ spec }, emit) => {
      emit.progress(10, `创建系统用户 ${spec.siteUser}`);
      const uid = await ensureSiteUser(spec, emit);
      emit.progress(20, '初始化站点目录结构');
      await ensureSiteDirs(spec, uid ?? 0, emit);
      return applySiteConfig(spec, emit);
    },
  },

  'site.apply': {
    validate: (args) => ({ spec: validateSpec(args.spec) }),
    run: async ({ spec }, emit) => {
      // 已存在的站点也要确保用户/目录存在（幂等）
      const uid = await ensureSiteUser(spec, emit);
      await ensureSiteDirs(spec, uid ?? 0, emit);
      return applySiteConfig(spec, emit);
    },
  },

  'site.remove': {
    validate: (args) => {
      const slug = s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE });
      const siteUser = s(args.siteUser, { field: 'siteUser', max: 32, pattern: USER_RE });
      // 必须与 site.apply 的约定一致：只允许删除该站点自己的系统用户，
      // 避免面板被攻破后传入 root / www-data 等账号造成系统级破坏。
      if (siteUser !== `xfm_${slug}`.slice(0, 32)) {
        throw new ArgError('站点系统用户必须为 xfm_<slug>');
      }
      return {
        slug,
        siteUser,
        keepFiles: args.keepFiles === undefined ? true : Boolean(args.keepFiles),
      };
    },
    run: async ({ slug, siteUser, keepFiles }, emit) => {
      const layout = nginxLayout();
      const vhostPath = path.join(layout.available, `xfm-${slug}.conf`);
      const linkPath = layout.useSymlink ? path.join(layout.enabled, `xfm-${slug}.conf`) : null;
      const root = siteRoot(slug);

      emit.progress(20, '移除 nginx 站点配置');
      if (linkPath) removeIfExists(linkPath);
      removeIfExists(vhostPath);

      emit.progress(45, '清理 PHP-FPM pool');
      const phpDir = '/etc/php';
      if (fs.existsSync(phpDir)) {
        for (const v of fs.readdirSync(phpDir)) {
          const p = path.join(phpDir, v, 'fpm', 'pool.d', `xfm-${slug}.conf`);
          if (fs.existsSync(p)) {
            removeIfExists(p);
            await run('systemctl', ['reload', `php${v}-fpm`], { timeout: 30_000, allowFailure: true });
          }
        }
      }

      emit.progress(65, '重载 nginx');
      const test = await runCapture('nginx', ['-t'], { timeout: 20_000 });
      if (test.ok) {
        await run('systemctl', ['reload', 'nginx'], { timeout: 60_000, allowFailure: true });
      } else {
        emit.log('warn', `nginx -t 未通过，跳过重载：${test.stderr}`);
      }

      if (!keepFiles) {
        emit.progress(80, '删除站点文件');
        await run('pkill', ['-u', siteUser], { timeout: 10000, allowFailure: true });
        const target = assertRealWithin(PATHS.WWW_ROOT, root);
        fs.rmSync(target, { recursive: true, force: true });
        emit.log('info', `已删除 ${target}`);
        await run('userdel', [siteUser], { timeout: 30_000, allowFailure: true });
        emit.log('info', `已删除系统用户 ${siteUser}`);
        const logDir = siteLogDir(slug);
        try {
          assertWithin(PATHS.SITE_LOG_ROOT, logDir);
          fs.rmSync(logDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      } else {
        emit.log('info', `站点文件已保留：${root}`);
      }

      emit.progress(100, '站点已移除');
      return { removed: true, keptFiles: keepFiles, root };
    },
  },

  'site.backup': {
    validate: (args) => ({
      slug: s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE }),
      root: absPath(args.root, [PATHS.WWW_ROOT], 'root'),
    }),
    run: async ({ slug, root }, emit) => {
      const backupDir = PATHS.BACKUP_ROOT;
      ensureDir(backupDir, { mode: 0o700 });
      const file = path.join(backupDir, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
      emit.log('info', `打包 ${root} → ${file}`);
      await run('tar', ['-czf', file, '-C', PATHS.WWW_ROOT, slug], {
        timeout: 30 * 60 * 1000,
        onLine: (line) => emit.log('info', line.slice(0, 300)),
      });
      const st = fs.statSync(file);
      emit.log('info', `备份完成，大小 ${(st.size / 1048576).toFixed(1)}MB`);
      return { path: file, sizeBytes: st.size };
    },
  },

  'site.log.tail': {
    validate: (args) => ({
      slug: s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE }),
      type: oneOf(args.type || 'access', ['access', 'error', 'php'], 'type'),
      lines: Math.min(Math.max(Number(args.lines) || 200, 10), 2000),
    }),
    run: async ({ slug, type, lines }) => {
      const dir = siteLogDir(slug);
      assertWithin(PATHS.SITE_LOG_ROOT, dir);
      const name = type === 'error' ? 'error.log' : type === 'php' ? 'php-error.log' : 'access.log';
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return { lines: [], file, missing: true };
      return { lines: readTail(file, lines), file };
    },
  },

  'site.usage': {
    validate: (args) => ({
      slug: s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE }),
      root: absPath(args.root, [PATHS.WWW_ROOT], 'root'),
    }),
    run: async ({ root }) => {
      const usage = dirUsage(root);
      return { ...usage, root };
    },
  },
};
