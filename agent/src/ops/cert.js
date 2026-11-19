/**
 * 证书操作：基于 certbot（HTTP-01 webroot 校验，不停 nginx）。
 *
 * 用 webroot 方式而不是 standalone/nginx 插件，原因是：
 *  - standalone 需要临时停 nginx，会中断线上业务；
 *  - --nginx 插件会改写本面板生成的 vhost，导致配置漂移。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, runCapture, exists } from '../lib/exec.js';
import { ensureDir, writeAtomic, assertWithin, readIfExists } from '../lib/fs-safe.js';
import { detectDistro, aptInstall, aptUpdate } from '../lib/distro.js';
import { PATHS, siteRoot } from '../../../shared/paths.js';
import { s, arr, absPath, oneOf, bool, SLUG_RE, DOMAIN_RE } from './args.js';

const LE_LIVE = '/etc/letsencrypt/live';

function certName(slug) {
  return `xfm-${slug}`;
}

async function ensureCertbot(emit) {
  if (await exists('certbot')) return;
  const distro = await detectDistro();
  if (distro.pkg !== 'apt') {
    const err = new Error('未安装 certbot，且当前发行版不支持自动安装');
    err.code = 'CERTBOT_MISSING';
    throw err;
  }
  emit.log('info', '未检测到 certbot，正在安装');
  await aptUpdate(emit);
  await aptInstall(['certbot'], emit);
  if (!(await exists('certbot'))) {
    const err = new Error('certbot 安装失败');
    err.code = 'CERTBOT_MISSING';
    throw err;
  }
}

function parseCertFile(file) {
  const pem = fs.readFileSync(file, 'utf8');
  const x509 = new crypto.X509Certificate(pem);
  return {
    subject: x509.subject.replace(/\n/g, ', '),
    issuer: x509.issuer.replace(/\n/g, ', '),
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: new Date(x509.validTo).toISOString(),
    fingerprint: x509.fingerprint256,
    serial: x509.serialNumber,
    altNames: (x509.subjectAltName || '').split(',').map((v) => v.trim().replace(/^DNS:/, '')).filter(Boolean),
  };
}

function pathsFor(slug) {
  const dir = path.join(LE_LIVE, certName(slug));
  return {
    dir,
    certPath: path.join(dir, 'cert.pem'),
    chainPath: path.join(dir, 'chain.pem'),
    fullchainPath: path.join(dir, 'fullchain.pem'),
    keyPath: path.join(dir, 'privkey.pem'),
  };
}

export const certOps = {
  'cert.issue': {
    validate: (args) => {
      const slug = s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE });
      const domains = arr(args.domains, { field: 'domains', max: 20 })
        .map((d) => s(d, { field: 'domains', max: 253 }).toLowerCase());
      if (!domains.length) throw Object.assign(new Error('缺少域名'), { code: 'BAD_ARGS' });
      for (const d of domains) {
        if (!DOMAIN_RE.test(d)) throw Object.assign(new Error(`域名不合法：${d}`), { code: 'BAD_ARGS' });
      }
      return {
        slug,
        domains,
        email: args.email ? s(args.email, { field: 'email', max: 128, pattern: /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/ }) : null,
        webroot: absPath(args.webroot, [PATHS.WWW_ROOT], 'webroot'),
        force: Boolean(args.force),
      };
    },
    run: async ({ slug, domains, email, webroot, force }, emit) => {
      await ensureCertbot(emit);
      const expected = path.join(siteRoot(slug), 'public');
      if (webroot !== expected) {
        throw Object.assign(new Error(`webroot 必须是 ${expected}`), { code: 'BAD_ARGS' });
      }
      const challengeDir = path.join(webroot, '.well-known', 'acme-challenge');
      ensureDir(challengeDir, { mode: 0o755 });
      await run('chown', ['-R', 'www-data:www-data', path.join(webroot, '.well-known')], { timeout: 10000, allowFailure: true });

      const p = pathsFor(slug);
      const args = [
        'certonly', '--webroot', '-w', webroot,
        '--cert-name', certName(slug),
        '--non-interactive', '--agree-tos', '--no-eff-email',
        '--expand', '--keep-until-expiring',
      ];
      if (force) args.push('--force-renewal');
      if (email) args.push('-m', email);
      for (const d of domains) args.push('-d', d);

      emit.progress(30, `certbot 申请证书：${domains.join(', ')}`);
      let out = '';
      await run('certbot', args, {
        timeout: 10 * 60 * 1000,
        onLine: (line, stream) => {
          out += `${line}\n`;
          if (!line.trim()) return;
          if (/error|failed|challenge|unauthorized|timeout|rate limit/i.test(line)) {
            emit.log('warn', line.slice(0, 400));
          } else if (stream === 'stdout') {
            emit.log('info', line.slice(0, 300));
          }
        },
      });

      if (!fs.existsSync(p.fullchainPath) || !fs.existsSync(p.keyPath)) {
        throw Object.assign(new Error('证书文件未生成，请检查 certbot 输出'), { code: 'CERT_MISSING' });
      }
      const info = parseCertFile(p.fullchainPath);
      emit.progress(100, '证书签发成功');
      emit.log('success', `有效期：${info.notBefore.slice(0, 10)} → ${info.notAfter.slice(0, 10)}`);
      return { ...info, ...p, log: out.split('\n').slice(-20) };
    },
  },

  'cert.renew': {
    validate: (args) => {
      const slug = s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE });
      const domains = arr(args.domains || [], { field: 'domains', max: 20 })
        .map((d) => s(d, { field: 'domains', max: 253 }).toLowerCase());
      return {
        slug,
        domains,
        email: args.email ? s(args.email, { field: 'email', max: 128 }) : null,
        webroot: absPath(args.webroot, [PATHS.WWW_ROOT], 'webroot'),
        // 默认不加 --force-renewal：certbot 只会在临近到期时真正续期，
        // 避免每次自动巡检都触发 Let's Encrypt 频率限制。
        force: Boolean(args.force),
      };
    },
    run: async ({ slug, webroot, force }, emit) => {
      await ensureCertbot(emit);
      const p = pathsFor(slug);
      if (!fs.existsSync(p.fullchainPath)) {
        const err = new Error('证书文件不存在，无法续期，请重新申请');
        err.code = 'CERT_MISSING';
        throw err;
      }
      const args = [
        'renew', '--cert-name', certName(slug),
        '--webroot', '-w', webroot,
        '--non-interactive', '--no-random-sleep-on-renew',
      ];
      if (force) args.push('--force-renewal');

      emit.progress(40, 'certbot 续期中');
      await run('certbot', args, {
        timeout: 10 * 60 * 1000,
        onLine: (line, stream) => {
          if (!line.trim()) return;
          if (/error|failed|rate limit|timeout/i.test(line)) emit.log('warn', line.slice(0, 400));
          else if (stream === 'stdout') emit.log('info', line.slice(0, 300));
        },
      });

      const info = parseCertFile(p.fullchainPath);
      emit.progress(100, '续期完成');
      return { ...info, ...p };
    },
  },

  'cert.revoke': {
    validate: (args) => ({
      slug: s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE }),
      domain: s(args.domain, { field: 'domain', max: 253, pattern: DOMAIN_RE }),
      deleteFiles: args.deleteFiles === undefined ? true : Boolean(args.deleteFiles),
    }),
    run: async ({ slug, domain, deleteFiles }, emit) => {
      await ensureCertbot(emit);
      const p = pathsFor(slug);
      if (fs.existsSync(p.certPath)) {
        emit.log('info', `吊销证书 ${domain}`);
        await run('certbot', [
          'revoke', '--cert-path', p.certPath, '--non-interactive', '--reason', 'superseded',
        ], { timeout: 300_000, allowFailure: true, onLine: (l) => emit.log('info', l.slice(0, 300)) });
      }
      if (deleteFiles) {
        await run('certbot', ['delete', '--cert-name', certName(slug), '--non-interactive'], {
          timeout: 120_000, allowFailure: true,
          onLine: (l) => emit.log('info', l.slice(0, 300)),
        });
        emit.log('info', '已删除该证书的续期任务与本地文件');
      }
      return { revoked: true, domain };
    },
  },

  'cert.upload': {
    validate: (args) => ({
      slug: s(args.slug, { field: 'slug', max: 32, pattern: SLUG_RE }),
      domain: s(args.domain, { field: 'domain', max: 253, pattern: DOMAIN_RE }),
      certPem: s(args.certPem, { field: 'certPem', min: 100, max: 200_000, pattern: /BEGIN CERTIFICATE/ }),
      keyPem: s(args.keyPem, { field: 'keyPem', min: 100, max: 200_000, pattern: /PRIVATE KEY/ }),
      chainPem: args.chainPem
        ? s(args.chainPem, { field: 'chainPem', min: 100, max: 200_000, pattern: /BEGIN CERTIFICATE/ })
        : '',
    }),
    run: async ({ slug, domain, certPem, keyPem, chainPem }, emit) => {
      let x509;
      let key;
      try {
        x509 = new crypto.X509Certificate(certPem);
        key = crypto.createPrivateKey(keyPem);
      } catch (err) {
        throw Object.assign(new Error(`证书或私钥解析失败：${err.message}`), { code: 'BAD_PEM' });
      }
      if (new Date(x509.validTo) < new Date()) {
        throw Object.assign(new Error('证书已过期，请上传有效期内的证书'), { code: 'CERT_EXPIRED' });
      }
      // 证书必须覆盖目标域名（SAN 优先，回退 CN），否则部署后浏览器仍会告警。
      if (!x509.checkHost(domain)) {
        throw Object.assign(new Error(`证书不包含域名 ${domain}（SAN/CN 校验失败）`), {
          code: 'CERT_DOMAIN_MISMATCH',
        });
      }
      const certPub = x509.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const keyPub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
      if (certPub !== keyPub) {
        throw Object.assign(new Error('私钥与证书不匹配'), { code: 'KEY_MISMATCH' });
      }
      if (chainPem) {
        try {
          new crypto.X509Certificate(chainPem);
        } catch (err) {
          throw Object.assign(new Error(`中间证书链解析失败：${err.message}`), { code: 'BAD_PEM' });
        }
      }

      const dir = path.join(PATHS.CERT_ROOT, slug);
      assertWithin(PATHS.CERT_ROOT, dir);
      ensureDir(dir, { mode: 0o750 });
      const base = domain.replace(/[^a-z0-9.-]/gi, '_');
      const certPath = path.join(dir, `${base}.crt`);
      const keyPath = path.join(dir, `${base}.key`);
      const chainPath = path.join(dir, `${base}.chain.crt`);
      const fullchainPath = path.join(dir, `${base}.fullchain.crt`);

      // 用户可能把完整链直接粘进 certPem，避免重复追加。
      const leaf = certPem.trim();
      const chain = chainPem.trim();
      const fullchain = chain && !leaf.includes(chain) ? `${leaf}\n${chain}` : leaf;

      writeAtomic(certPath, `${leaf}\n`, { mode: 0o644 });
      writeAtomic(keyPath, keyPem.endsWith('\n') ? keyPem : `${keyPem}\n`, { mode: 0o600 });
      if (chain) writeAtomic(chainPath, `${chain}\n`, { mode: 0o644 });
      writeAtomic(fullchainPath, `${fullchain}\n`, { mode: 0o644 });

      emit.log('info', `证书已写入 ${dir}（私钥权限 0600）`);
      const info = {
        issuer: x509.issuer.replace(/\n/g, ', '),
        notBefore: new Date(x509.validFrom).toISOString(),
        notAfter: new Date(x509.validTo).toISOString(),
        fingerprint: x509.fingerprint256,
      };
      return { certPath, keyPath, chainPath: chain ? chainPath : null, fullchainPath, ...info };
    },
  },

  'cert.inspect': {
    validate: (args) => ({ certPath: absPath(args.certPath, ['/etc/letsencrypt/live', PATHS.CERT_ROOT], 'certPath') }),
    run: async ({ certPath }) => {
      if (!fs.existsSync(certPath)) {
        throw Object.assign(new Error('证书文件不存在'), { code: 'CERT_MISSING' });
      }
      return { ...parseCertFile(certPath), certPath };
    },
  },
};
