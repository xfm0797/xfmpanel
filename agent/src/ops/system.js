/**
 * 系统信息与探活。
 */

import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns/promises';
import { runCapture } from '../lib/exec.js';
import { ensureMetrics, startMetricsSampler } from '../lib/host-metrics.js';
import { s, oneOf } from './args.js';
import { DOMAIN_RE } from './args.js';

startMetricsSampler();

/** 判断是否私网地址（用于区分「公网访问地址」与「内网地址」） */
function isPrivateAddress(addr) {
  if (addr.includes(':')) {
    const a = addr.toLowerCase();
    return a.startsWith('fc') || a.startsWith('fd') || a === '::1' || a.startsWith('::ffff:');
  }
  const [a, b] = addr.split('.').map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** 本机可用地址（自动排除 lo / 容器网桥 / 链路本地） */
function collectAddresses() {
  const result = { ipv4: [], ipv6: [], primary: { ipv4: null, ipv6: null } };
  const skipIface = /^(lo|docker|veth|br-|virbr|tun|tap|zt|tailscale|wg)/i;

  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skipIface.test(name)) continue;
    for (const item of list || []) {
      if (item.internal) continue;
      const isV4 = item.family === 'IPv4' || item.family === 4;
      const isV6 = item.family === 'IPv6' || item.family === 6;
      if (isV4 && item.address.startsWith('169.254.')) continue;
      if (isV6 && /^fe80/i.test(item.address)) continue;
      if (!isV4 && !isV6) continue;

      const entry = { iface: name, address: item.address, private: isPrivateAddress(item.address) };
      const bucket = isV4 ? result.ipv4 : result.ipv6;
      if (!bucket.some((x) => x.address === entry.address)) bucket.push(entry);
    }
  }

  for (const key of ['ipv4', 'ipv6']) {
    const list = result[key];
    // 优先返回公网地址，没有公网再用私网（NAT 型 VPS 常见）
    result.primary[key] = (list.find((x) => !x.private) || list[0])?.address || null;
  }
  return result;
}

function readOsRelease() {
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    const map = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) map[m[1]] = m[2];
    }
    return map;
  } catch {
    return {};
  }
}

function memInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => Number((new RegExp(`${key}:\\s+(\\d+)`).exec(raw) || [])[1] || 0);
    return {
      memTotalMb: Math.round(kb('MemTotal') / 1024),
      memFreeMb: Math.round(kb('MemAvailable') / 1024),
    };
  } catch {
    return {
      memTotalMb: Math.round(os.totalmem() / 1048576),
      memFreeMb: Math.round(os.freemem() / 1048576),
    };
  }
}

export const systemOps = {
  'system.ping': {
    validate: () => ({}),
    run: async () => ({ pong: true, uid: process.getuid?.() ?? -1, pid: process.pid, ts: Date.now() }),
  },

  'system.info': {
    validate: () => ({}),
    run: async () => {
      const rel = readOsRelease();
      const df = await runCapture('df', ['-kP', '/'], { timeout: 5000 });
      let disk = { totalGb: 0, usedGb: 0, usagePercent: 0 };
      if (df.ok) {
        const line = df.stdout.split('\n')[1] || '';
        const parts = line.split(/\s+/);
        const total = Number(parts[1]) * 1024;
        const used = Number(parts[2]) * 1024;
        disk = {
          totalGb: Math.round(total / 1073741824),
          usedGb: Math.round(used / 1073741824),
          usagePercent: total ? Math.round((used / total) * 100) : 0,
        };
      }
      const mem = memInfo();
      const uptime = Number((fs.readFileSync('/proc/uptime', 'utf8') || '0').split(' ')[0]) || 0;
      return {
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        distro: [rel.PRETTY_NAME || rel.NAME, rel.VERSION_CODENAME ? `(${rel.VERSION_CODENAME})` : ''].filter(Boolean).join(' ') || 'Unknown',
        distroId: rel.ID || 'unknown',
        kernel: os.release(),
        arch: process.arch,
        cpu: os.cpus()[0]?.model || 'unknown',
        cpuCores: os.cpus().length,
        memTotalMb: mem.memTotalMb,
        memFreeMb: mem.memFreeMb,
        loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
        uptimeSec: Math.round(uptime),
        disk,
        addresses: collectAddresses(),
        nodeVersion: process.version,
        agentUid: process.getuid?.() ?? -1,
      };
    },
  },

  /** 实时指标：CPU / 内存 / 磁盘 / 网络（由 agent 内置采样器每秒更新） */
  'system.metrics': {
    validate: () => ({}),
    run: async () => ensureMetrics(),
  },

  'dns.check': {
    validate: (args) => ({ domain: s(args.domain, { field: 'domain', max: 253, pattern: DOMAIN_RE }).toLowerCase() }),
    run: async ({ domain }) => {
      try {
        const [a4, a6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
        const a = a4.status === 'fulfilled' ? a4.value : [];
        const aaaa = a6.status === 'fulfilled' ? a6.value : [];
        return { domain, a, aaaa, resolved: a.length + aaaa.length > 0 };
      } catch (err) {
        return { domain, a: [], aaaa: [], resolved: false, error: err.code || err.message };
      }
    },
  },
};
