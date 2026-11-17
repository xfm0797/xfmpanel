/**
 * 主机指标采样器：CPU / 内存 / 磁盘 / 网络。
 *
 * 设计要点：
 *   1) 只在 agent（root）侧读取 /proc 与 statfs，面板进程拿不到任何原始设备信息；
 *   2) CPU 与网络是「增量指标」，必须保留上一次采样做差分 —— 因此由 agent 内部
 *      以固定周期（1s）采样并缓存最近一次结果，面板按需读取，不需要自己算时间窗；
 *   3) 非 Linux 环境（开发机）自动退化为 os.cpus()/os.freemem()，不会抛错。
 *
 * 返回结构（system.metrics）：
 *   { at, uptimeSec, cpu:{usage,cores,loadavg,perCore?}, mem:{...}, disk:{...}, net:{...} }
 */

import fs from 'node:fs';
import os from 'node:os';

const HAS_PROC = (() => {
  try {
    return fs.statSync('/proc/stat').isFile();
  } catch {
    return false;
  }
})();

const SAMPLE_INTERVAL_MS = 1000;
const DISK_PATH = '/';

let prev = null;
let latest = null;
let timer = null;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/* ------------------------------------------------------------------ 原始采集 */

function readCpuTimes() {
  if (HAS_PROC) {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const v = line.trim().split(/\s+/).slice(1).map(Number);
      // user nice system idle iowait irq softirq steal guest guest_nice
      const idle = (v[3] || 0) + (v[4] || 0);
      const total = v.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      return { total, idle };
    } catch {
      /* 落到 os.cpus() 分支 */
    }
  }
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

function readMem() {
  let totalKb = 0;
  let availKb = 0;
  let swapTotalKb = 0;
  let swapFreeKb = 0;

  if (HAS_PROC) {
    try {
      const raw = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(raw) || [])[1] || 0);
      totalKb = kb('MemTotal');
      availKb = kb('MemAvailable') || kb('MemFree') + kb('Buffers') + kb('Cached');
      swapTotalKb = kb('SwapTotal');
      swapFreeKb = kb('SwapFree');
    } catch {
      /* ignore */
    }
  }
  if (!totalKb) {
    totalKb = Math.round(os.totalmem() / 1024);
    availKb = Math.round(os.freemem() / 1024);
  }

  const totalBytes = totalKb * 1024;
  const availBytes = availKb * 1024;
  const usedBytes = Math.max(0, totalBytes - availBytes);
  return {
    totalBytes,
    usedBytes,
    availBytes,
    usagePercent: totalBytes ? round((usedBytes / totalBytes) * 100, 1) : 0,
    totalMb: Math.round(totalBytes / 1048576),
    usedMb: Math.round(usedBytes / 1048576),
    availMb: Math.round(availBytes / 1048576),
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: Math.max(0, (swapTotalKb - swapFreeKb) * 1024),
  };
}

function readDisk() {
  let totalBytes = 0;
  let freeBytes = 0;

  if (typeof fs.statfsSync === 'function') {
    try {
      const st = fs.statfsSync(DISK_PATH);
      totalBytes = Number(st.blocks) * Number(st.bsize);
      // 与应用可用空间对齐（bfree 含 root 保留块，bavail 才是普通进程可用）
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* ignore */
    }
  }
  if (!totalBytes) return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0, unavailable: true };

  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: round((usedBytes / totalBytes) * 100, 1),
    totalGb: round(totalBytes / 1073741824, 1),
    usedGb: round(usedBytes / 1073741824, 1),
  };
}

/** 默认路由出接口（读 /proc/net/route，失败则取第一个有流量的非 lo 接口） */
function pickIface() {
  if (HAS_PROC) {
    try {
      const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const f = line.trim().split(/\s+/);
        // Iface Destination Gateway Flags ... ；Destination=00000000 即默认路由
        if (f.length > 2 && f[1] === '00000000') return f[0];
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    let best = null;
    let bestRx = 0;
    for (const line of raw.split('\n').slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      if (name === 'lo') continue;
      const rx = Number(m[2].trim().split(/\s+/)[0] || 0);
      if (rx > bestRx) {
        best = name;
        bestRx = rx;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function readNet(iface) {
  if (!iface) {
    // 退化：把非 lo 接口全部累加（避开 docker/veth 之类的虚拟网卡影响）
    let rx = 0;
    let tx = 0;
    try {
      const raw = fs.readFileSync('/proc/net/dev', 'utf8');
      for (const line of raw.split('\n').slice(2)) {
        const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'lo' || /^(docker|veth|br-|virbr)/.test(name)) continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0;
        tx += f[8] || 0;
      }
    } catch {
      /* ignore */
    }
    return { iface: null, rx, tx };
  }
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of raw.split('\n').slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m || m[1].trim() !== iface) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      return { iface, rx: f[0] || 0, tx: f[8] || 0 };
    }
  } catch {
    /* ignore */
  }
  return { iface, rx: 0, tx: 0 };
}

function readUptimeSec() {
  if (HAS_PROC) {
    try {
      return Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0);
    } catch {
      /* ignore */
    }
  }
  return Math.round(os.uptime());
}

function collect() {
  return {
    at: Date.now(),
    cpu: readCpuTimes(),
    mem: readMem(),
    disk: readDisk(),
    net: readNet(pickIface()),
    uptimeSec: readUptimeSec(),
  };
}

/* ------------------------------------------------------------------ 差分计算 */

/**
 * 采样一次并更新缓存。返回最新指标快照。
 * 首次调用只建立基线，返回 null（调用方用 ensureMetrics 等待）。
 */
export function sampleMetrics() {
  const snap = collect();
  if (!prev) {
    prev = snap;
    return null;
  }

  const dt = (snap.at - prev.at) / 1000;
  if (dt <= 0.05) return latest;

  const dTotal = snap.cpu.total - prev.cpu.total;
  const dIdle = snap.cpu.idle - prev.cpu.idle;
  const cpuUsage = dTotal > 0 ? clamp((1 - dIdle / dTotal) * 100, 0, 100) : 0;

  // 计数器回绕/网卡重启时会出现负数，按 0 处理而不是给出异常峰值
  const rxBps = clamp((snap.net.rx - prev.net.rx) / dt, 0, Number.MAX_SAFE_INTEGER);
  const txBps = clamp((snap.net.tx - prev.net.tx) / dt, 0, Number.MAX_SAFE_INTEGER);

  const loadavg = os.loadavg().map((v) => round(v, 2));

  latest = {
    at: snap.at,
    uptimeSec: snap.uptimeSec,
    hostname: os.hostname(),
    cpu: {
      usage: round(cpuUsage, 1),
      cores: os.cpus().length,
      loadavg,
      loadPercent: os.cpus().length ? round((loadavg[0] / os.cpus().length) * 100, 1) : 0,
      model: os.cpus()[0]?.model?.trim() || 'unknown',
    },
    mem: snap.mem,
    disk: snap.disk,
    net: {
      iface: snap.net.iface,
      rxBps: Math.round(rxBps),
      txBps: Math.round(txBps),
      rxTotal: snap.net.rx,
      txTotal: snap.net.tx,
    },
    intervalMs: SAMPLE_INTERVAL_MS,
  };
  prev = snap;
  return latest;
}

export function getMetrics() {
  return latest;
}

/** 启动后台采样（进程级，只调一次） */
export function startMetricsSampler() {
  if (timer) return;
  prev = collect(); // 建立基线，避免第一次读数为 0
  timer = setInterval(() => {
    try {
      sampleMetrics();
    } catch {
      /* 采样失败不影响 agent 主流程 */
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

/**
 * 等待一份可用指标（首次请求可能在 1s 窗口内到达）。
 * @param {number} waitMs 最长等待时间
 */
export async function ensureMetrics(waitMs = 1200) {
  if (latest) return latest;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const m = sampleMetrics();
    if (m) return m;
  }
  // 兜底：返回结构完整的零值快照，前端不会因为字段缺失报错
  const snap = collect();
  return {
    at: snap.at,
    uptimeSec: snap.uptimeSec,
    hostname: os.hostname(),
    cpu: {
      usage: 0,
      cores: os.cpus().length,
      loadavg: os.loadavg().map((v) => round(v, 2)),
      loadPercent: 0,
      model: os.cpus()[0]?.model?.trim() || 'unknown',
    },
    mem: snap.mem,
    disk: snap.disk,
    net: { iface: snap.net.iface, rxBps: 0, txBps: 0, rxTotal: snap.net.rx, txTotal: snap.net.tx },
    intervalMs: SAMPLE_INTERVAL_MS,
    warmingUp: true,
  };
}
