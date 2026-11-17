/**
 * SSL 证书：列表、签发、续期、吊销、上传、巡检。
 */

import { api, state } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  const [certs, stats, sites] = await Promise.all([
    api('/certificates'),
    api('/certificates/stats'),
    api('/sites?size=200').catch(() => ({ items: [] })),
  ]);
  const canWrite = state.me?.permissions?.includes('*') || state.me?.permissions?.includes('cert:write');
  const list = Array.isArray(certs) ? certs : [];

  el.innerHTML = `
    <div class="grid cols-4 mb">
      ${stat('证书总数', stats.total || 0, '含已过期')}
      ${stat('即将过期', stats.byStatus?.expiring || 0, '30 天内到期', 'warn')}
      ${stat('已过期', stats.byStatus?.expired || 0, 'HTTPS 可能不可用', 'err')}
      ${stat('失败', stats.byStatus?.failed || 0, '需人工介入', 'warn')}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>证书列表</h2>
        <span class="hint">到期前 30 天自动续期（webroot 方式，不停服务）</span>
        <div class="spacer"></div>
        ${canWrite ? '<button class="btn btn-sm btn-ghost" data-role="scan">立即巡检</button>'
          + '<button class="btn btn-sm btn-ghost" data-role="upload">上传证书</button>'
          + '<button class="btn btn-primary" data-role="issue">申请证书</button>' : ''}
      </div>
      ${list.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>域名</th><th>站点</th><th>状态</th><th>有效期</th><th>自动续期</th><th class="right">操作</th></tr></thead>
        <tbody>${list.map((c) => `
          <tr>
            <td><div class="mono cell-main">${ui.esc(c.domain)}</div>
              ${c.altNames?.length ? `<div class="cell-sub">+${c.altNames.length} 个 SAN</div>` : ''}</td>
            <td class="small">${c.siteName ? ui.esc(c.siteName) : '<span class="faint">—</span>'}</td>
            <td>${ui.badge(c.status)}${c.lastError ? `<div class="cell-sub" style="color:#ff8b84" title="${ui.esc(c.lastError)}">失败原因</div>` : ''}</td>
            <td class="small">
              <div>${ui.fmtDate(c.notAfter, false)}</div>
              <div class="cell-sub">${c.daysLeft === null ? '—' : c.daysLeft < 0 ? `已过期 ${-c.daysLeft} 天` : `剩余 ${c.daysLeft} 天`}</div>
            </td>
            <td class="small">${c.autoRenew ? '<span class="badge ok">开启</span>' : '<span class="badge muted">关闭</span>'}</td>
            <td class="actions">
              ${canWrite ? `<button class="btn btn-sm" data-renew="${c.id}">续期</button>
              <button class="btn btn-sm btn-ghost" data-revoke="${c.id}">吊销</button>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty"><strong>暂无证书</strong>
        在站点详情页或右上角「申请证书」为域名签发 Let's Encrypt 证书。</div>`}
    </div>

    <div class="card mt">
      <div class="card-head"><h2>异常与提示</h2></div>
      <div class="small dim" style="line-height:1.9">
        · <strong>签发失败</strong>：最常见原因是域名未解析到本机、80 端口被防火墙拦截，或触发 Let's Encrypt 频率限制。<br />
        · <strong>续期失败</strong>：面板会每 6 小时巡检并自动重试，连续失败会升级为严重告警；请检查 webroot 目录权限与 DNS。<br />
        · <strong>已过期</strong>：nginx 会拒绝握手，请立即续期或上传有效证书。
      </div>
    </div>
  `;

  el.querySelectorAll('[data-renew]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api(`/certificates/${btn.dataset.renew}/renew`, { method: 'POST' });
        ui.toast('续期任务已创建');
        ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
        ctx.refresh();
      } catch (err) { ui.toast(err.message, 'err'); btn.disabled = false; }
    });
  });

  el.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await ui.confirmDialog({
        title: '吊销证书',
        message: '吊销后站点会回退到 HTTP，直到重新签发。确定继续？',
        danger: true,
        confirmText: '吊销',
      });
      if (!ok) return;
      try {
        const res = await api(`/certificates/${btn.dataset.revoke}/revoke`, { method: 'POST' });
        ui.toast('吊销任务已创建');
        ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
        ctx.refresh();
      } catch (err) { ui.toast(err.message, 'err'); }
    });
  });

  el.querySelector('[data-role="scan"]')?.addEventListener('click', async () => {
    try {
      const res = await api('/certificates/scan', { method: 'POST' });
      ui.toast(`巡检完成：检查 ${res.checked} 个，状态变更 ${res.changed} 个，续期入队 ${res.queued?.length || 0} 个`);
      ctx.refresh();
    } catch (err) { ui.toast(err.message, 'err'); }
  });

  el.querySelector('[data-role="issue"]')?.addEventListener('click', () => openIssue(sites.items || [], ctx));
  el.querySelector('[data-role="upload"]')?.addEventListener('click', () => openUpload(sites.items || [], ctx));
}

function stat(label, value, foot, tone) {
  return `<div class="card tight"><div class="stat">
    <div class="stat-label">${ui.esc(label)}</div>
    <div class="stat-value" ${tone ? `style="color:var(--${tone === 'err' ? 'danger' : 'warn'})"` : ''}>${ui.esc(value)}</div>
    <div class="stat-foot">${ui.esc(foot)}</div>
  </div></div>`;
}

function openIssue(sites, ctx) {
  if (!sites.length) { ui.toast('请先创建站点', 'warn'); return; }
  const { node, close } = ui.openModal({
    title: '申请 SSL 证书',
    subtitle: 'Let\'s Encrypt · HTTP-01 校验，不中断服务',
    body: `
      <div class="field"><label>目标站点</label>
        <select class="select" data-f="site">${sites.map((s) =>
          `<option value="${s.id}">${ui.esc(s.name)}（${ui.esc(s.domain)}）</option>`).join('')}</select>
      </div>
      <div class="field"><label>域名（逗号分隔，含主域名）</label>
        <input class="input" data-f="domains" value="${ui.esc(sites[0].domains?.join(', ') || sites[0].domain)}" />
      </div>
      <div class="check mb"><input type="checkbox" id="force2" data-f="force" /><label for="force2">强制重签（已有证书覆盖）</label></div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
      <div class="small faint">签发前会自动检查域名解析；若 DNS 未生效会给出提示，但仍会尝试签发。</div>
    `,
    footer: '<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" data-role="ok">开始申请</button>',
    width: 500,
  });
  const siteSelect = node.querySelector('[data-f="site"]');
  siteSelect.addEventListener('change', () => {
    const s = sites.find((x) => String(x.id) === siteSelect.value);
    if (s) node.querySelector('[data-f="domains"]').value = (s.domains || [s.domain]).join(', ');
  });
  node.querySelector('[data-role="ok"]').addEventListener('click', async () => {
    const domains = node.querySelector('[data-f="domains"]').value.split(/[,，\s]+/).filter(Boolean);
    try {
      const res = await api('/certificates/issue', {
        method: 'POST',
        body: {
          siteId: Number(siteSelect.value),
          domains,
          force: node.querySelector('[data-f="force"]').checked,
        },
      });
      close();
      ui.toast('证书申请任务已创建');
      ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
      ctx.refresh();
    } catch (err) {
      node.querySelector('[data-role="msg"]').textContent = err.message;
    }
  });
}

function openUpload(sites, ctx) {
  if (!sites.length) { ui.toast('请先创建站点', 'warn'); return; }
  const { node, close } = ui.openModal({
    title: '上传证书',
    subtitle: '适用于商业证书或已有证书迁移',
    body: `
      <div class="row">
        <div class="field"><label>站点</label>
          <select class="select" data-f="site">${sites.map((s) =>
            `<option value="${s.id}">${ui.esc(s.name)}（${ui.esc(s.domain)}）</option>`).join('')}</select></div>
        <div class="field"><label>域名</label><input class="input" data-f="domain" value="${ui.esc(sites[0].domain)}" /></div>
      </div>
      <div class="field"><label>证书（PEM，含完整链）</label><textarea class="textarea" data-f="cert" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
      <div class="field"><label>私钥（PEM）</label><textarea class="textarea" data-f="key" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
      <div class="small faint">agent 会校验证书与私钥是否匹配、是否过期，私钥以 0600 权限落盘。</div>
    `,
    footer: '<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" data-role="ok">上传并部署</button>',
    width: 620,
  });
  node.querySelector('[data-role="ok"]').addEventListener('click', async () => {
    try {
      const res = await api('/certificates/upload', {
        method: 'POST',
        body: {
          siteId: Number(node.querySelector('[data-f="site"]').value),
          domain: node.querySelector('[data-f="domain"]').value.trim(),
          certPem: node.querySelector('[data-f="cert"]').value.trim(),
          keyPem: node.querySelector('[data-f="key"]').value.trim(),
        },
      });
      close();
      ui.toast('证书上传任务已创建');
      ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
      ctx.refresh();
    } catch (err) {
      node.querySelector('[data-role="msg"]').textContent = err.message;
    }
  });
}
