/**
 * 告警中心：证书、任务、站点异常的统一入口。
 */

import { api } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  let openOnly = true;
  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>告警</h2>
        <span class="hint" data-role="count"></span>
        <div class="spacer"></div>
        <label class="check"><input type="checkbox" data-role="open" checked /> 只看未确认</label>
        <button class="btn btn-sm btn-ghost" data-role="refresh">刷新</button>
      </div>
      <div data-role="list"></div>
    </div>
  `;
  const listEl = el.querySelector('[data-role="list"]');

  const load = async () => {
    listEl.innerHTML = '<div class="skeleton" style="width:50%"></div>';
    const data = await api(`/alerts?size=100${openOnly ? '&open=1' : ''}`);
    el.querySelector('[data-role="count"]').textContent = `未确认 ${data.openCount} 条`;
    if (!data.items.length) {
      listEl.innerHTML = '<div class="empty"><strong>没有告警</strong>系统运行正常</div>';
      return;
    }
    listEl.innerHTML = `<div class="list">${data.items.map((a) => `
      <div class="list-item" style="align-items:flex-start">
        <span class="badge ${a.level === 'critical' ? 'err' : a.level === 'warning' ? 'warn' : 'info'}" style="margin-top:2px">
          ${a.level === 'critical' ? '严重' : a.level === 'warning' ? '警告' : '提示'}
        </span>
        <div class="grow">
          <div class="cell-main">${ui.esc(a.title)}</div>
          <div class="small dim">${ui.esc(a.message)}</div>
          <div class="cell-sub">${ui.esc(a.source)} · ${ui.esc(a.code)} · ${ui.fmtDate(a.createdAt)}${a.acknowledged ? ' · 已确认' : ''}</div>
        </div>
        ${a.acknowledged ? '' : `<button class="btn btn-sm" data-ack="${a.id}">确认</button>`}
      </div>`).join('')}</div>`;

    listEl.querySelectorAll('[data-ack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/alerts/${btn.dataset.ack}/ack`, { method: 'POST' });
          ui.toast('已确认告警');
          ctx.refreshChrome();
          load();
        } catch (err) { ui.toast(err.message, 'err'); }
      });
    });
  };

  el.querySelector('[data-role="open"]').addEventListener('change', (e) => { openOnly = e.target.checked; load(); });
  el.querySelector('[data-role="refresh"]').addEventListener('click', load);
  await load();
}
