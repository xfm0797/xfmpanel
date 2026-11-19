/**
 * 开发用 agent 桩（XFMP_AGENT_MODE=stub 或 Windows）。
 *
 * 目标：在非 Linux 环境也能完整跑通面板的交互链路（任务流、日志、证书状态机），
 * 但不触碰真实系统。生产环境必须使用 agent/src/agent.js。
 *
 * 约定：域名中包含 "fail" 时模拟失败，便于验证异常提示与回滚提示。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { config } from '../config.js';
import { renderSiteVhost, certPathsFor } from '../../../shared/render/nginx.js';
import { renderPhpPool } from '../../../shared/render/php-pool.js';
import { nginxVhostPath, phpPoolPath, siteRoot } from '../../../shared/paths.js';

const state = {
  services: new Map([
    ['nginx', { active: true, since: '2026-01-01T00:00:00Z' }],
    ['mariadb', { active: true, since: '2026-01-01T00:00:00Z' }],
    ['redis-server', { active: false, since: null }],
  ]),
  runtimes: new Map(),
  appliedSites: new Map(),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 开发环境真实网卡地址（与生产 system.info.addresses 结构一致） */
function stubAddresses() {
  const result = { ipv4: [], ipv6: [], primary: { ipv4: null, ipv6: null } };
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.internal) continue;
      const v6 = item.family === 'IPv6' || item.family === 6;
      if (v6 && /^fe80/i.test(item.address)) continue;
      const bucket = v6 ? result.ipv6 : result.ipv4;
      if (bucket.some((x) => x.address === item.address)) continue;
      bucket.push({ iface, address: item.address, private: true });
    }
  }
  result.primary.ipv4 = result.ipv4[0]?.address || null;
  result.primary.ipv6 = result.ipv6[0]?.address || null;
  return result;
}

async function steps(list, { onLog, onProgress }) {
  for (let i = 0; i < list.length; i += 1) {
    const item = typeof list[i] === 'string' ? { log: list[i] } : list[i];
    if (item.log) onLog?.('info', item.log);
    if (item.warn) onLog?.('warn', item.warn);
    if (item.progress !== undefined) onProgress?.(item.progress, item.log);
    await sleep(item.wait ?? 120);
    if (item.error) throw Object.assign(new Error(item.error), { code: 'STUB_FAILED' });
  }
}

export async function stubCall(op, args = {}, { onLog, onProgress } = {}) {
  onLog?.('info', `[stub] ${op} ${JSON.stringify(args).slice(0, 160)}`);

  switch (op) {
    case 'system.ping':
      return { pong: true, mode: 'stub', ts: Date.now() };

    case 'system.info':
      return {
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        distro: config.isDev ? 'Development Sandbox' : 'Ubuntu 24.04 LTS',
        kernel: os.release(),
        arch: process.arch,
        cpu: os.cpus()[0]?.model || 'unknown',
        cpuCores: os.cpus().length,
        memTotalMb: Math.round(os.totalmem() / 1048576),
        memFreeMb: Math.round(os.freemem() / 1048576),
        loadavg: os.loadavg(),
        uptimeSec: Math.round(os.uptime()),
        disk: { totalGb: 80, usedGb: 31, usagePercent: 39 },
        addresses: stubAddresses(),
        panelVersion: config.version,
        agentMode: 'stub',
      };

    case 'system.metrics': {
      // 用真实内存 + 正弦波模拟 CPU/网络，让开发环境的曲线也有起伏
      const t = Date.now() / 1000;
      const cores = os.cpus().length;
      const load = os.loadavg()[0] || 0;
      const base = Math.min(75, Math.max(4, (load / Math.max(1, cores)) * 100));
      const cpuUsage = Math.min(99, Math.max(1, base + Math.sin(t / 9) * 12 + (Math.random() - 0.5) * 8));
      const memTotal = os.totalmem();
      const memAvail = os.freemem();
      const memUsed = Math.max(0, memTotal - memAvail);
      const diskTotal = 80 * 1073741824;
      const diskUsed = 31 * 1073741824;
      const rx = 40_000 + Math.max(0, Math.sin(t / 6)) * 900_000 + Math.random() * 120_000;
      const tx = 20_000 + Math.max(0, Math.cos(t / 7)) * 400_000 + Math.random() * 60_000;
      return {
        at: Date.now(),
        uptimeSec: Math.round(os.uptime()),
        hostname: os.hostname(),
        cpu: {
          usage: Math.round(cpuUsage * 10) / 10,
          cores,
          loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
          loadPercent: Math.round((load / Math.max(1, cores)) * 1000) / 10,
          model: os.cpus()[0]?.model?.trim() || 'Stub CPU',
        },
        mem: {
          totalBytes: memTotal,
          usedBytes: memUsed,
          availBytes: memAvail,
          usagePercent: Math.round((memUsed / memTotal) * 1000) / 10,
          totalMb: Math.round(memTotal / 1048576),
          usedMb: Math.round(memUsed / 1048576),
          availMb: Math.round(memAvail / 1048576),
          swapTotalBytes: 0,
          swapUsedBytes: 0,
        },
        disk: {
          totalBytes: diskTotal,
          usedBytes: diskUsed,
          freeBytes: diskTotal - diskUsed,
          usagePercent: 38.8,
          totalGb: 80,
          usedGb: 31,
        },
        net: {
          iface: 'eth0',
          rxBps: Math.round(rx),
          txBps: Math.round(tx),
          rxTotal: 1_284_000_000,
          txTotal: 392_000_000,
        },
        intervalMs: 5000,
      };
    }

    case 'service.status': {
      const s = state.services.get(args.unit) || { active: false };
      return {
        unit: args.unit,
        active: s.active,
        state: s.active ? 'active' : 'inactive',
        since: s.since,
        enabled: s.active,
        version: args.unit === 'nginx' ? '1.24.0' : undefined,
      };
    }

    case 'service.action': {
      if (!['start', 'stop', 'restart', 'reload', 'enable'].includes(args.action)) {
        throw Object.assign(new Error('不支持的动作'), { code: 'BAD_ACTION' });
      }
      const cur = state.services.get(args.unit) || {};
      const active = args.action === 'stop' ? false : true;
      state.services.set(args.unit, { ...cur, active, since: new Date().toISOString() });
      onLog?.('info', `${args.unit} ${args.action} 完成`);
      return { unit: args.unit, action: args.action, active };
    }

    case 'nginx.test':
      onLog?.('info', 'nginx: configuration file /etc/nginx/nginx.conf test is successful');
      return { ok: true };

    case 'nginx.reload':
      onLog?.('info', 'nginx 已平滑重载');
      return { ok: true };

    case 'runtime.catalog':
      return { items: [] };

    case 'runtime.install': {
      const { kind, version } = args;
      onLog?.('info', `开始安装 ${kind} ${version}`);
      await steps([
        { log: '检查系统架构与软件源…', progress: 5 },
        { log: 'apt-get update', progress: 15, wait: 200 },
        { log: `安装 ${kind} ${version} 软件包（模拟）`, progress: 45, wait: 300 },
        { log: '写入面板优化配置', progress: 70 },
        { log: '启动并设置开机自启', progress: 88 },
        { log: `${kind} ${version} 安装完成`, progress: 100 },
      ], { onLog, onProgress });
      state.runtimes.set(`${kind}-${version}`, { kind, version, status: 'active' });
      const unit = kind === 'php' ? `php${version}-fpm`
        : kind === 'redis' ? 'redis-server'
          : kind === 'nodejs' ? null
            : kind;
      return { kind, version, status: 'active', serviceName: unit };
    }

    case 'runtime.remove': {
      await steps([`停止 ${args.serviceName || args.kind} 服务`, `卸载 ${args.kind} 软件包`], { onLog });
      state.runtimes.delete(`${args.kind}-${args.version}`);
      return { removed: true };
    }

    case 'site.apply':
    case 'site.provision': {
      const spec = args.spec;
      onLog?.('info', `校验站点规格 ${spec.slug}`);
      if (spec.domains.some((d) => d.includes('fail'))) {
        await steps([{ log: 'nginx -t 配置测试' }, { error: 'nginx 配置测试失败：模拟的配置错误' }], { onLog });
      }
      const vhost = renderSiteVhost(spec);
      const pool = spec.appType === 'php' ? renderPhpPool(spec) : null;

      const vhostPath = nginxVhostPath(spec.slug);
      const poolPath = spec.appType === 'php' ? phpPoolPath(spec.phpVersion, spec.slug) : null;

      await steps([
        { log: `创建系统用户 ${spec.siteUser}`, progress: 20 },
        { log: `初始化目录 ${siteRoot(spec.slug)}`, progress: 40 },
        { log: `写入 vhost ${vhostPath}`, progress: 60 },
        ...(poolPath ? [{ log: `写入 php-fpm pool ${poolPath}`, progress: 70 }] : []),
        { log: 'nginx -t 配置测试通过', progress: 85 },
        { log: '重载 nginx / php-fpm', progress: 95 },
      ], { onLog, onProgress });

      state.appliedSites.set(spec.slug, { spec, vhost, pool });
      return {
        applied: true,
        vhostPath,
        poolPath,
        rendered: { vhost, pool },
        appliedAt: new Date().toISOString(),
      };
    }

    case 'site.remove': {
      await steps([
        { log: `移除 nginx vhost`, progress: 30 },
        { log: `清理 php-fpm pool`, progress: 55 },
        { log: '重载服务', progress: 80 },
        { log: '站点已删除（站点目录按策略保留）', progress: 100 },
      ], { onLog, onProgress });
      state.appliedSites.delete(args.slug);
      return { removed: true, keptFiles: true };
    }

    case 'site.backup': {
      const file = path.join(config.dataDir, 'backups', `${args.slug}-${Date.now()}.tar.gz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `stub backup of ${args.slug}`);
      const size = fs.statSync(file).size;
      onLog?.('info', `已生成备份 ${file}`);
      return { path: file, sizeBytes: size };
    }

    case 'site.backup.prune': {
      const dir = path.join(config.dataDir, 'backups');
      if (!fs.existsSync(dir)) return { scanned: 0, deleted: [], freedBytes: 0 };
      const cutoff = Date.now() - (Number(args.keepDays) || 30) * 86400 * 1000;
      const deleted = [];
      let freedBytes = 0;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.tar.gz')) continue;
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        if (st.mtimeMs >= cutoff) continue;
        fs.unlinkSync(file);
        deleted.push(file);
        freedBytes += st.size;
      }
      return { scanned: deleted.length, deleted, freedBytes };
    }

    case 'site.log.tail': {
      const now = Date.now();
      const lines = Array.from({ length: Math.min(args.lines || 50, 100) }, (_, i) => {
        const t = new Date(now - (100 - i) * 1000).toISOString().replace('T', ' ').slice(0, 19);
        return args.type === 'error'
          ? `${t} [warn] 1024#0: *${1000 + i} upstream response delayed, client: 10.0.0.${i % 250}, server: ${args.slug}`
          : `10.0.0.${i % 250} - - [${t} +0800] "GET /index.php HTTP/1.1" 200 ${1200 + i} "-" "Mozilla/5.0"`;
      });
      return { lines };
    }

    case 'site.usage':
      return { diskMb: 128, files: 842, lastWrite: new Date().toISOString() };

    case 'cert.issue':
    case 'cert.renew': {
      const domains = args.domains || [args.domain];
      if (domains.some((d) => String(d).includes('fail'))) {
        await steps([
          { log: `请求 Let's Encrypt 证书：${domains.join(', ')}`, progress: 20 },
          { warn: 'HTTP-01 校验失败：域名未解析到本机' },
          { error: '签发失败：DNS 未生效或 80 端口不可达' },
        ], { onLog, onProgress });
      }
      await steps([
        { log: `使用 webroot 方式申请证书：${domains.join(', ')}`, progress: 20 },
        { log: '发送 ACME 订单', progress: 45 },
        { log: '完成 HTTP-01 校验', progress: 75 },
        { log: '证书已签发并写入站点配置', progress: 100 },
      ], { onLog, onProgress });

      const slug = args.slug || 'stub';
      // 返回 POSIX 虚拟路径（与生产一致），文件写到开发沙箱里做占位
      const paths = certPathsFor(slug, domains[0]);
      const mirrorDir = path.join(config.dataDir, 'certs', slug);
      fs.mkdirSync(mirrorDir, { recursive: true });
      const notBefore = new Date();
      const notAfter = new Date(Date.now() + 90 * 86400 * 1000);
      const fake = `-----BEGIN CERTIFICATE-----\nSTUB-${crypto.randomBytes(8).toString('hex')}\n-----END CERTIFICATE-----\n`;
      for (const p of [paths.certPath, paths.keyPath, paths.fullchainPath]) {
        fs.writeFileSync(path.join(mirrorDir, path.basename(p)), fake);
      }

      return {
        certPath: paths.certPath,
        keyPath: paths.keyPath,
        fullchainPath: paths.fullchainPath,
        issuer: "Let's Encrypt (Stub)",
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        fingerprint: crypto.randomBytes(20).toString('hex').toUpperCase().match(/.{2}/g).join(':'),
      };
    }

    case 'cert.revoke':
      return { revoked: true };

    case 'cert.upload': {
      const mirrorDir = path.join(config.dataDir, 'certs', args.slug);
      fs.mkdirSync(mirrorDir, { recursive: true });
      const certPath = `/etc/xfmpanel/certs/${args.slug}/${args.domain}.crt`;
      const keyPath = `/etc/xfmpanel/certs/${args.slug}/${args.domain}.key`;
      fs.writeFileSync(path.join(mirrorDir, `${args.domain}.crt`), args.certPem);
      fs.writeFileSync(path.join(mirrorDir, `${args.domain}.key`), args.keyPem);
      return { certPath, keyPath, fullchainPath: certPath };
    }

    case 'cert.inspect':
      return { valid: true, notAfter: new Date(Date.now() + 80 * 86400 * 1000).toISOString() };

    case 'dns.check': {
      try {
        const records = await dns.resolve4(args.domain);
        return { domain: args.domain, a: records, resolved: records.length > 0 };
      } catch (err) {
        return { domain: args.domain, a: [], resolved: false, error: err.code || err.message };
      }
    }

    default:
      throw Object.assign(new Error(`stub 未实现的操作：${op}`), { code: 'NOT_IMPLEMENTED' });
  }
}
