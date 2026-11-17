/**
 * 概览：VPS 实时状态图、服务健康、站点与证书概要、最近任务与告警。
 */

import { api } from '../api.js';
import * as ui from '../ui.js';
import { chart, niceMax } from '../chart.js';

const POLL_MS = 5000;

const COLOR = {
  cpu: 'var(--accent)',
  mem: 'var(--blue)',
  disk: 'var(--warn)',
  rx: 'var(--blue)',
  tx: 'var(--accent)',
};

export async function render(el, ctx) {
  const [overview, alerts, metrics] = await Promise.all([
    api('/system/overview'),
    api('/alerts?open=1&size=5').catch(() => ({ items: [] })),
    api('/system/metrics').catch((err) => ({ available: false, error: err.message, series: [] })),
  ]);

  const sys = overview.system || {};
  const agentOk = overview.agent?.ok;

  const services = overview.services || [];
  const certs = overview.certs || { byStatus: {}, soon: [] };
  const tasks = overview.tasks?.recent || [];
  const openAlerts = alerts.items || [];

  const addrV4 = overview.panel?.publicIpv4 || sys.addresses?.primary?.ipv4 || '';
  const addrV6 = overview.panel?.publicIpv6 || sys.addresses?.primary?.ipv6 || '';
  const addrText = [addrV4, addrV6 ? `[${addrV6}]` : ''].filter(Boolean).join('  ·  ') || '—';

  el.innerHTML = `
    <div class="grid cols-4 mb">
      ${statCard('站点总数', overview.sites?.total ?? 0, `${overview.sites?.byStatus?.active || 0} 个运行中`, 'sites')}
      ${statCard('SSL 证书', certs.total ?? 0, `${certs.byStatus?.expiring || 0} 个临期 / ${certs.byStatus?.expired || 0} 个过期`, 'certs')}
      ${statCard('待处理告警', overview.alerts?.open ?? 0, (overview.alerts?.open || 0) ? '需要关注' : '一切正常', 'alerts', (overview.alerts?.open || 0) > 0 ? 'warn' : '')}
      ${statCard('环境组件', services.length, agentOk ? `agent ${overview.agent.mode} · ${overview.agent.latencyMs}ms` : 'agent 离线', 'runtimes', agentOk ? '' : 'err')}
    </div>

    <section class="card mb" data-role="vps-metrics">
      <div class="card-head">
        <h2>VPS 实时状态</h2>
        <span class="hint">每 ${Math.round((metrics.intervalMs || POLL_MS) / 1000)} 秒采样 · 最近 ${metrics.windowMinutes || 15} 分钟</span>
        <div class="spacer"></div>
        <span class="badge ${metrics.available ? 'ok' : 'err'}" data-role="metrics-state">${metrics.available ? '实时' : '采集异常'}</span>
      </div>
      <div data-role="metrics-body">${metricsBody(metrics)}</div>
    </section>

    <div class="grid split mb">
      <div class="card">
        <div class="card-head">
          <h2>主机状态</h2>
          <span class="hint">${ui.esc(sys.distro || '—')}</span>
          <div class="spacer"></div>
          <span class="badge ${agentOk ? 'ok' : 'err'}">${agentOk ? 'agent 在线' : 'agent 离线'}</span>
        </div>
        ${sys.unavailable ? `<div class="empty"><strong>无法读取主机信息</strong>${ui.esc(sys.error || '')}</div>` : `
          <dl class="kv">
            <dt>主机名</dt><dd>${ui.esc(sys.hostname || '—')}</dd>
            <dt>系统 / 内核</dt><dd>${ui.esc(sys.distro || sys.os || '—')} · ${ui.esc(sys.kernel || '')}</dd>
            <dt>CPU</dt><dd class="truncate" title="${ui.esc(sys.cpu || '')}">${ui.esc(sys.cpu || '—')} × ${sys.cpuCores || 0}</dd>
            <dt>负载</dt><dd>${(sys.loadavg || []).join(' / ') || '—'}</dd>
            <dt>访问地址</dt><dd class="mono small">${ui.esc(addrText)}</dd>
            <dt>运行时长</dt><dd>${ui.fmtDuration(sys.uptimeSec)}</dd>
          </dl>
        `}
      </div>

      <div class="card">
        <div class="card-head"><h2>服务健康</h2><div class="spacer"></div>
          <span class="hint">${services.length} 个组件</span>
        </div>
        ${services.length ? `<div class="list">${services.map((s) => `
          <div class="list-item">
            <div class="grow">
              <div class="cell-main">${ui.esc(s.kind)} <span class="faint mono">${ui.esc(s.version)}</span></div>
              <div class="cell-sub mono">${ui.esc(s.unit)}</div>
            </div>
            ${s.error ? `<span class="badge err" title="${ui.esc(s.error)}">不可用</span>` : ui.badge(s.active ? 'active' : 'stopped')}
          </div>`).join('')}</div>`
    : `<div class="empty"><strong>还没有安装网站环境</strong>前往「网站环境」一键安装 Nginx / PHP</div>`}
      </div>
    </div>

    <div class="grid split">
      <div class="card">
        <div class="card-head"><h2>最近任务</h2><div class="spacer"></div><a class="small" href="#/tasks">全部任务 →</a></div>
        ${tasks.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>任务</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>${tasks.map((t) => `
            <tr data-task="${ui.esc(t.id)}" style="cursor:pointer">
              <td><div class="cell-main truncate">${ui.esc(t.title)}</div><div class="cell-sub mono">${ui.esc(t.type)}</div></td>
              <td>${ui.badge(t.status)}</td>
              <td class="faint small nowrap">${ui.fmtRelative(t.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty"><strong>暂无任务</strong>创建站点或安装环境后会在这里显示</div>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>证书与告警</h2><div class="spacer"></div><a class="small" href="#/certs">证书 →</a></div>
        ${(certs.soon || []).length ? `<div class="list mb">${certs.soon.slice(0, 4).map((c) => `
          <div class="list-item">
            <div class="grow"><div class="cell-main truncate mono">${ui.esc(c.domain)}</div>
              <div class="cell-sub">${ui.fmtDate(c.notAfter, false)} 到期${c.autoRenew ? ' · 自动续期' : ''}</div></div>
            ${c.daysLeft < 0 ? '<span class="badge err">已过期</span>' : c.daysLeft <= 15 ? `<span class="badge warn">${c.daysLeft} 天</span>` : `<span class="badge ok">${c.daysLeft} 天</span>`}
          </div>`).join('')}</div>` : '<div class="small faint mb">暂无临期证书</div>'}
        ${openAlerts.length ? `<div class="sec-title">未确认告警</div><div class="list">${openAlerts.map((a) => `
          <div class="list-item">
            <div class="grow"><div class="cell-main truncate">${ui.esc(a.title)}</div>
              <div class="cell-sub truncate">${ui.esc(a.message)}</div></div>
            <span class="badge ${a.level === 'critical' ? 'err' : 'warn'}">${a.level === 'critical' ? '严重' : '警告'}</span>
          </div>`).join('')}</div>` : ''}
      </div>
    </div>
  `;

  el.querySelectorAll('[data-task]').forEach((row) => {
    row.addEventListener('click', async () => {
      try {
        const task = await api(`/tasks/${row.dataset.task}`);
        ctx.openTask(task);
      } catch (err) { ui.toast(err.message, 'err'); }
    });
  });

  startMetricsPolling(el);
}

/* ------------------------------------------------------------------ 指标卡 */

function metricsBody(m) {
  if (!m || !m.available || !m.current) {
    return `<div class="empty">
      <strong>暂时读不到主机指标</strong>
      ${ui.esc(m?.error || 'agent 服务未就绪')}
      <div class="small faint mt">指标由 xfmpanel-agent 采集，可执行 systemctl status xfmpanel-agent 检查</div>
    </div>`;
  }

  const cur = m.current;
  const series = Array.isArray(m.series) ? m.series : [];
  const values = (key) => series.map((p) => Number(p[key]) || 0);

  const cpuValues = values('cpu');
  const memValues = values('mem');
  const diskValues = values('disk');
  const rxValues = values('rx');
  const txValues = values('tx');

  const cpu = cur.cpu || {};
  const mem = cur.mem || {};
  const disk = cur.disk || {};
  const net = cur.net || {};

  const peak = (arr) => (arr.length ? Math.max(...arr) : 0);
  const netMax = niceMax(Math.max(peak(rxValues), peak(txValues), 64 * 1024));
  // CPU 常年在低位徘徊，用 0-100 会把曲线压成一条贴底的线；
  // 按窗口峰值自适应（下限 10%），内存/磁盘变化慢，仍用固定 0-100 更直观。
  const cpuMax = Math.min(100, Math.max(10, niceMax(peak(cpuValues) * 1.15 || 10)));

  return `
    <div class="metrics-grid">
      ${metricCard({
        label: 'CPU',
        value: `${(cpu.usage ?? 0).toFixed(0)}<small>%</small>`,
        sub: `${cpu.cores || '—'} 核 · 负载 ${(cpu.loadavg?.[0] ?? 0).toFixed(2)} · 峰值 ${peak(cpuValues).toFixed(0)}%`,
        svg: chart([{ values: cpuValues, color: COLOR.cpu }], { max: cpuMax }),
      })}
      ${metricCard({
        label: '内存',
        value: `${(mem.usagePercent ?? 0).toFixed(0)}<small>%</small>`,
        sub: `${toGb(mem.usedBytes)} / ${toGb(mem.totalBytes)} GB 已用 · 峰值 ${peak(memValues).toFixed(0)}%`,
        svg: chart([{ values: memValues, color: COLOR.mem }], { max: 100 }),
      })}
      ${metricCard({
        label: '磁盘',
        value: `${(disk.usagePercent ?? 0).toFixed(0)}<small>%</small>`,
        sub: `${toGb(disk.usedBytes)} / ${toGb(disk.totalBytes)} GB 已用 · 剩余 ${toGb(disk.freeBytes)} GB`,
        svg: chart([{ values: diskValues, color: COLOR.disk }], { max: 100 }),
        tone: (disk.usagePercent || 0) > 88 ? 'danger' : (disk.usagePercent || 0) > 75 ? 'warn' : '',
      })}
      ${metricCard({
        label: '网络',
        value: `<span style="color:${COLOR.rx}">↓</span> ${ui.fmtBytes(net.rxBps || 0)}<small>/s</small>`,
        sub: `<span style="color:${COLOR.tx}">↑</span> ${ui.fmtBytes(net.txBps || 0)}/s · ${ui.esc(net.iface || '自动')}`,
        svg: chart([
          { values: rxValues, color: COLOR.rx },
          { values: txValues, color: COLOR.tx, fill: false },
        ], { max: netMax }),
        legend: `<span class="legend-item"><i style="background:${COLOR.rx}"></i>下行</span>
                 <span class="legend-item"><i style="background:${COLOR.tx}"></i>上行</span>`,
      })}
    </div>
  `;
}

function metricCard({ label, value, sub, svg, tone = '', legend = '' }) {
  return `<div class="metric ${tone ? `tone-${tone}` : ''}">
    <div class="metric-head">
      <span class="metric-label">${ui.esc(label)}</span>
      ${legend ? `<span class="metric-legend">${legend}</span>` : ''}
      <span class="metric-value">${value}</span>
    </div>
    <div class="metric-sub truncate" title="${ui.esc(stripTags(sub))}">${sub}</div>
    <div class="metric-chart">${svg}</div>
  </div>`;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '');
}

function toGb(bytes) {
  return ((Number(bytes) || 0) / 1073741824).toFixed(1);
}

function startMetricsPolling(el) {
  const token = `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  el.dataset.metricsToken = token;
  let stopped = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };

  const tick = async () => {
    if (stopped) return;
    // 视图被路由切换（innerHTML 被替换）后自动停止，避免后台空转
    if (!el.isConnected || el.dataset.metricsToken !== token) {
      stop();
      return;
    }
    if (document.hidden) return;
    try {
      const m = await api('/system/metrics');
      if (stopped || el.dataset.metricsToken !== token) return;
      const body = el.querySelector('[data-role="metrics-body"]');
      if (body) body.innerHTML = metricsBody(m);
      const badge = el.querySelector('[data-role="metrics-state"]');
      if (badge) {
        badge.className = `badge ${m.available ? 'ok' : 'err'}`;
        badge.textContent = m.available ? '实时' : '采集异常';
      }
    } catch {
      // 单次失败静默重试；连续失败由后端限流记录日志
    }
  };

  timer = setInterval(tick, POLL_MS);
  activeTick = tick;
}

// 单个模块级监听：页面重新可见时立刻补一次数据，避免切回来看到的还是旧曲线
let activeTick = null;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) activeTick?.();
});

function statCard(label, value, foot, target, tone = '') {
  return `<div class="card tight">
    <div class="stat">
      <div class="stat-label">${ui.esc(label)}</div>
      <div class="stat-value ${tone === 'err' ? '' : ''}" ${tone ? `style="color:var(${tone === 'err' ? '--danger' : '--warn'})"` : ''}>${ui.esc(value)}</div>
      <div class="stat-foot">${ui.esc(foot)}</div>
    </div>
  </div>`;
}
