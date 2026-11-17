/**
 * 网站环境：按组件展示可选版本、已安装实例、服务控制与安装入口。
 */

import { api, state } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  const [data, health] = await Promise.all([
    api('/runtimes'),
    api('/runtimes/health').catch(() => ({ services: [] })),
  ]);
  const canWrite = state.me?.permissions?.includes('*') || state.me?.permissions?.includes('runtime:write');
  const healthMap = new Map((health.services || []).map((s) => [s.id, s]));
  const pendingByTarget = new Map();
  for (const t of data.pendingTasks || []) pendingByTarget.set(String(t.targetId), t);

  el.innerHTML = `
    <div class="grid cols-2" data-role="groups">
      ${(data.groups || []).map((g) => groupCard(g, healthMap, pendingByTarget, canWrite)).join('')}
    </div>
    <div class="card mt">
      <div class="card-head"><h2>安装说明</h2></div>
      <div class="small dim" style="line-height:1.9">
        · 所有安装都通过面板的特权 agent 执行，使用系统包管理器（apt），失败会保留完整命令输出。<br />
        · PHP 每个版本独立安装，站点可在详情页切换版本；每个站点使用独立系统用户与 FPM pool。<br />
        · 建议顺序：Nginx → PHP → MariaDB / Redis（数据库与缓存仅监听 127.0.0.1）。
      </div>
    </div>
  `;

  el.querySelectorAll('[data-install]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.install;
      const select = el.querySelector(`[data-version-for="${kind}"]`);
      const version = select?.value;
      if (!version) return;
      btn.disabled = true;
      try {
        const res = await api('/runtimes/install', { method: 'POST', body: { kind, version } });
        ui.toast(`已开始安装 ${kind} ${version}`);
        ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
        ctx.refresh();
      } catch (err) {
        ui.toast(err.message, 'err');
        btn.disabled = false;
      }
    });
  });

  el.querySelectorAll('[data-service]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [id, action] = btn.dataset.service.split(':');
      btn.disabled = true;
      try {
        await api(`/runtimes/${id}/service`, { method: 'POST', body: { action } });
        ui.toast(`已执行 ${action}`);
        ctx.refresh();
      } catch (err) {
        ui.toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  });

  el.querySelectorAll('[data-default]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/runtimes/${btn.dataset.default}/default`, { method: 'POST' });
        ui.toast('已设为默认版本');
        ctx.refresh();
      } catch (err) { ui.toast(err.message, 'err'); }
    });
  });

  el.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await ui.confirmDialog({
        title: '卸载运行环境',
        message: '卸载会停止服务并移除软件包，站点数据不会被删除。确定继续？',
        danger: true,
        confirmText: '卸载',
      });
      if (!ok) return;
      try {
        const res = await api(`/runtimes/${btn.dataset.remove}`, { method: 'DELETE' });
        ui.toast('卸载任务已创建');
        ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
        ctx.refresh();
      } catch (err) { ui.toast(err.message, 'err'); }
    });
  });

  el.querySelectorAll('[data-task]').forEach((b) => {
    b.addEventListener('click', () => {
      ctx.openTask({ id: b.dataset.task, title: '安装进度', type: 'runtime.install', status: 'running', progress: 0 });
    });
  });
}

function groupCard(group, healthMap, pendingByTarget, canWrite) {
  const installed = group.installed || [];
  const task = (pendingByTarget.get(`${group.kind}:${group.versions?.[0]?.version}`) || null);
  const options = (group.versions || []).map((v) =>
    `<option value="${ui.esc(v.version)}">${ui.esc(v.label || v.version)}</option>`).join('');

  return `<div class="card">
    <div class="card-head">
      <h2>${ui.esc(group.label)}</h2>
      <span class="hint">${ui.esc(group.description)}</span>
      <div class="spacer"></div>
      ${group.hasActive ? '<span class="badge ok">已就绪</span>' : '<span class="badge muted">未安装</span>'}
    </div>

    ${installed.length ? `<div class="list mb">${installed.map((r) => {
      const h = healthMap.get(r.id);
      return `<div class="list-item">
        <div class="grow">
          <div class="cell-main">${ui.esc(r.version)} ${r.isDefault ? '<span class="badge info">默认</span>' : ''}</div>
          <div class="cell-sub mono">${ui.esc(r.serviceName || '无服务')}${h?.since ? ` · 自 ${ui.fmtRelative(h.since)}` : ''}</div>
        </div>
        <div class="inline">
          ${r.status === 'active'
            ? `<span class="badge ${h && !h.active ? 'warn' : 'ok'}">${h && !h.active ? '已停止' : '运行中'}</span>`
            : ui.badge(r.status)}
          ${canWrite && r.serviceName ? `
            <button class="btn btn-sm btn-ghost" data-service="${r.id}:restart">重启</button>
            <button class="btn btn-sm btn-ghost" data-service="${r.id}:stop">停止</button>` : ''}
          ${canWrite && !r.isDefault ? `<button class="btn btn-sm" data-default="${r.id}">设为默认</button>` : ''}
          ${canWrite ? `<button class="btn btn-sm btn-ghost" data-remove="${r.id}">卸载</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>` : '<div class="small faint mb">尚未安装任何版本</div>'}

    ${canWrite ? `<div class="inline">
      <select class="select" data-version-for="${ui.esc(group.kind)}" style="max-width:200px">${options}</select>
      <button class="btn btn-primary btn-sm" data-install="${ui.esc(group.kind)}">安装</button>
      <span class="small faint">安装过程约 1–5 分钟，可在任务中心查看实时输出</span>
    </div>` : ''}
  </div>`;
}
