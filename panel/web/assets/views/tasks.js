/**
 * 任务中心：筛选、查看实时输出、取消任务。
 */

import { api } from '../api.js';
import * as ui from '../ui.js';

const FILTERS = [
  ['', '全部状态'],
  ['running', '执行中'],
  ['queued', '排队中'],
  ['success', '成功'],
  ['failed', '失败'],
  ['canceled', '已取消'],
];

export async function render(el, ctx) {
  let status = '';
  let type = '';

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>任务队列</h2>
        <span class="hint" data-role="summary"></span>
        <div class="spacer"></div>
        <select class="select" data-role="status" style="width:140px">
          ${FILTERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
        <select class="select" data-role="type" style="width:170px">
          <option value="">全部类型</option>
          <option value="runtime.install">安装环境</option>
          <option value="site.create">创建站点</option>
          <option value="site.apply">应用配置</option>
          <option value="site.remove">删除站点</option>
          <option value="cert.issue">申请证书</option>
          <option value="cert.renew">续期证书</option>
        </select>
        <button class="btn btn-sm btn-ghost" data-role="refresh">刷新</button>
      </div>
      <div data-role="table"></div>
    </div>
  `;

  const table = el.querySelector('[data-role="table"]');
  const summary = el.querySelector('[data-role="summary"]');

  const load = async () => {
    table.innerHTML = '<div class="skeleton" style="width:50%"></div>';
    const qs = new URLSearchParams({ size: '50' });
    if (status) qs.set('status', status);
    if (type) qs.set('type', type);
    const data = await api(`/tasks?${qs}`);
    summary.textContent = `共 ${data.total} 个任务`;
    if (!data.items.length) {
      table.innerHTML = '<div class="empty"><strong>没有符合条件的任务</strong>安装环境、创建站点等操作都会生成任务</div>';
      return;
    }
    table.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th style="width:34%">任务</th><th>状态</th><th>进度</th><th>创建时间</th><th>耗时</th><th class="right"></th></tr></thead>
      <tbody>${data.items.map((t) => row(t)).join('')}</tbody></table></div>`;

    table.querySelectorAll('[data-task]').forEach((tr) => {
      tr.addEventListener('click', async (e) => {
        if (e.target.closest('[data-cancel]')) return;
        const task = await api(`/tasks/${tr.dataset.task}`);
        ctx.openTask(task, { onFinished: () => load() });
      });
    });
    table.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api(`/tasks/${btn.dataset.cancel}/cancel`, { method: 'POST' });
          ui.toast('已请求取消', 'warn');
          load();
        } catch (err) { ui.toast(err.message, 'err'); }
      });
    });
  };

  el.querySelector('[data-role="status"]').addEventListener('change', (e) => { status = e.target.value; load(); });
  el.querySelector('[data-role="type"]').addEventListener('change', (e) => { type = e.target.value; load(); });
  el.querySelector('[data-role="refresh"]').addEventListener('click', load);
  await load();
}

function row(t) {
  const cost = t.startedAt && t.finishedAt
    ? `${Math.max(1, Math.round((new Date(t.finishedAt) - new Date(t.startedAt)) / 1000))} 秒`
    : t.startedAt ? '进行中' : '—';
  return `<tr data-task="${ui.esc(t.id)}" style="cursor:pointer">
    <td>
      <div class="cell-main truncate">${ui.esc(t.title)}</div>
      <div class="cell-sub mono">${ui.esc(t.type)} · ${ui.esc(t.targetType || '-')}:${ui.esc(t.targetId || '-')}</div>
    </td>
    <td>${ui.badge(t.status)}${t.error ? `<div class="cell-sub" style="color:#ff8b84" title="${ui.esc(t.error)}">查看日志 →</div>` : ''}</td>
    <td style="min-width:120px;max-width:150px">
      <div class="progress"><span style="width:${t.progress || 0}%"></span></div>
      <div class="cell-sub">${t.progress || 0}%</div>
    </td>
    <td class="small faint nowrap">${ui.fmtDate(t.createdAt)}</td>
    <td class="small faint nowrap">${cost}</td>
    <td class="actions">${t.status === 'queued'
      ? `<button class="btn btn-sm btn-ghost" data-cancel="${ui.esc(t.id)}">取消</button>` : ''}</td>
  </tr>`;
}
