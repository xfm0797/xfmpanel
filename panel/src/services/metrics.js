/**
 * 主机指标序列（内存环形缓冲）。
 *
 * 职责：
 *   * 后台每 5 秒向 agent 取一次 system.metrics，压平成前端画图用的点；
 *   * 保存最近 15 分钟（180 点）滑动窗口，新打开页面的浏览器立刻能看到历史曲线，
 *     不需要先空等一两分钟；
 *   * 面板重启后历史清空（只在内存里），CPU/网络本来就是增量指标，落盘意义不大。
 *
 * 该模块不做鉴权，只由 routes/system.js 暴露，权限在路由层校验。
 */

import { callAgent } from './agent.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('metrics');

const SAMPLE_INTERVAL_MS = 5000;
const MAX_POINTS = 180; // 5s * 180 = 15 分钟

const state = {
  series: [],
  latest: null,
  available: false,
  error: null,
  collecting: false,
  lastSampleAt: 0,
  lastErrorLogAt: 0,
};

let timer = null;

const round = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
};

function toPoint(m) {
  return {
    t: m.at || Date.now(),
    cpu: round(m.cpu?.usage, 1),
    mem: round(m.mem?.usagePercent, 1),
    disk: round(m.disk?.usagePercent, 1),
    rx: Math.round(m.net?.rxBps || 0),
    tx: Math.round(m.net?.txBps || 0),
  };
}

/** 采一次样（去重：并发调用共享同一次请求） */
export async function sampleMetrics() {
  if (state.collecting) return state.latest;
  state.collecting = true;
  try {
    const m = await callAgent('system.metrics', {}, { timeoutMs: 5000 });
    state.latest = m;
    state.available = true;
    state.error = null;
    state.lastSampleAt = Date.now();

    const point = toPoint(m);
    const last = state.series[state.series.length - 1];
    // 同一秒内的重复采样不重复入队（刷新页面触发的即时采样常见）
    if (!last || point.t - last.t >= 1000) {
      state.series.push(point);
      if (state.series.length > MAX_POINTS) state.series.splice(0, state.series.length - MAX_POINTS);
    } else {
      state.series[state.series.length - 1] = point;
    }
    return m;
  } catch (err) {
    state.available = false;
    state.error = err.message;
    // agent 离线时每 5 秒一次请求会刷屏，这里限流到 5 分钟一条
    if (Date.now() - state.lastErrorLogAt > 5 * 60 * 1000) {
      state.lastErrorLogAt = Date.now();
      log.warn(`指标采样失败：${err.message}`);
    }
    return null;
  } finally {
    state.collecting = false;
  }
}

export function startMetricsSampler() {
  if (timer) return;
  sampleMetrics();
  timer = setInterval(() => {
    sampleMetrics();
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopMetricsSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 前端轮询入口：返回当前值 + 历史序列 */
export async function metricsSnapshot({ refresh = false } = {}) {
  const stale = Date.now() - state.lastSampleAt > SAMPLE_INTERVAL_MS * 2;
  if (refresh || stale) await sampleMetrics();

  return {
    available: state.available,
    error: state.error,
    intervalMs: SAMPLE_INTERVAL_MS,
    windowMinutes: Math.round((MAX_POINTS * SAMPLE_INTERVAL_MS) / 60000),
    collectedAt: state.lastSampleAt ? new Date(state.lastSampleAt).toISOString() : null,
    current: state.latest,
    series: state.series,
  };
}
