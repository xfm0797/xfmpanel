/**
 * 日志审计：面板运行日志（JSON 行）+ 操作审计表。
 */

import { api } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="panel">面板日志</div>
      <div class="tab" data-tab="audit">操作审计</div>
    </div>
    <div data-role="panel"></div>
  `;
  const body = el.querySelector('[data-role="panel"]');
  const tabs = el.querySelectorAll('[data-tab]');
  const show = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    if (name === 'panel') renderPanelLog(body); else renderAudit(body);
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  show('panel');
}

async function renderPanelLog(body) {
  body.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>面板运行日志</h2>
        <span class="hint" data-role="file"></span>
        <div class="spacer"></div>
        <select class="select" data-role="level" style="width:130px">
          <option value="">全部级别</option>
          <option value="error">仅 error</option>
          <option value="warn">仅 warn</option>
        </select>
        <select class="select" data-role="lines" style="width:130px">
          <option value="200">200 行</option>
          <option value="500" selected>500 行</option>
          <option value="1000">1000 行</option>
        </select>
        <button class="btn btn-sm" data-role="refresh">刷新</button>
      </div>
      <pre class="log" data-role="log">加载中…</pre>
    </div>
  `;
  const logEl = body.querySelector('[data-role="log"]');
  const load = async () => {
    const level = body.querySelector('[data-role="level"]').value;
    const lines = body.querySelector('[data-role="lines"]').value;
    try {
      const res = await api(`/logs/panel?lines=${lines}${level ? `&level=${level}` : ''}`);
      body.querySelector('[data-role="file"]').textContent = res.file || '';
      logEl.innerHTML = (res.lines || []).map(formatLine).join('') || '<span class="lv-meta">（暂无日志）</span>';
      logEl.scrollTop = logEl.scrollHeight;
    } catch (err) {
      logEl.textContent = `读取失败：${err.message}`;
    }
  };
  body.querySelector('[data-role="refresh"]').addEventListener('click', load);
  body.querySelector('[data-role="level"]').addEventListener('change', load);
  body.querySelector('[data-role="lines"]').addEventListener('change', load);
  await load();
}

function formatLine(raw) {
  try {
    const e = JSON.parse(raw);
    const cls = e.level === 'error' ? 'lv-error' : e.level === 'warn' ? 'lv-warn' : 'lv-info';
    const time = String(e.t || '').replace('T', ' ').slice(0, 19);
    const ctx = e.ctx ? ` ${JSON.stringify(e.ctx)}` : '';
    return `<span class="${cls}">${ui.esc(time)}  ${ui.esc((e.level || '').toUpperCase().padEnd(5))} ${ui.esc(e.module || '')} — ${ui.esc(e.msg)}${ui.esc(ctx)}</span>\n`;
  } catch {
    return `<span class="lv-meta">${ui.esc(raw)}</span>\n`;
  }
}

async function renderAudit(body) {
  let page = 1;
  const load = async () => {
    body.innerHTML = '<div class="card"><div class="skeleton" style="width:60%"></div></div>';
    const data = await api(`/logs/audit?page=${page}&size=30`);
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>操作审计</h2>
          <span class="hint">共 ${data.total} 条 · 所有写操作都会留痕</span>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-ghost" data-role="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="small faint">第 ${data.page} 页</span>
          <button class="btn btn-sm btn-ghost" data-role="next" ${data.items.length < data.size ? 'disabled' : ''}>下一页</button>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>来源 IP</th></tr></thead>
          <tbody>${data.items.map((a) => `
            <tr>
              <td class="small nowrap">${ui.fmtDate(a.at)}</td>
              <td class="small">${ui.esc(a.actorName)}</td>
              <td class="mono small">${ui.esc(a.action)}</td>
              <td class="small">${ui.esc(a.resource || '')}${a.resourceId ? ` <span class="faint mono">#${ui.esc(a.resourceId)}</span>` : ''}</td>
              <td>${a.result === 'success' ? '<span class="badge ok">成功</span>' : '<span class="badge err">失败</span>'}</td>
              <td class="mono small faint">${ui.esc(a.ip || '—')}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
    `;
    body.querySelector('[data-role="prev"]')?.addEventListener('click', () => { page = Math.max(1, page - 1); load(); });
    body.querySelector('[data-role="next"]')?.addEventListener('click', () => { page += 1; load(); });
  };
  await load();
}
