/**
 * 站点管理：列表 / 新建 / 详情（配置预览、日志、证书）/ 启停 / 删除。
 */

import { api, state } from '../api.js';
import * as ui from '../ui.js';

let cache = { items: [], runtimes: [], settings: {} };

export async function render(el, ctx) {
  const [list, runtimes, settings] = await Promise.all([
    api('/sites?size=200'),
    api('/runtimes').catch(() => ({ installed: [] })),
    api('/settings').catch(() => ({ settings: {} })),
  ]);
  cache = {
    items: list.items || [],
    runtimes: (runtimes.installed || []).filter((r) => r.kind === 'php' && r.status === 'active'),
    settings: settings.settings || {},
  };

  const canWrite = state.me?.permissions?.includes('*') || state.me?.permissions?.includes('site:write');

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>站点列表</h2>
        <span class="hint">共 ${cache.items.length} 个站点</span>
        <div class="spacer"></div>
        <input class="input" data-role="search" placeholder="搜索名称 / 域名 / 标识" style="width:230px" />
        <button class="btn btn-primary" data-role="create" ${canWrite ? '' : 'disabled'}>+ 新建站点</button>
      </div>
      ${cache.items.length ? `
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th style="width:26%">站点</th>
              <th>域名</th>
              <th>运行环境</th>
              <th>状态</th>
              <th>证书</th>
              <th class="right">操作</th>
            </tr>
          </thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>` : `
      <div class="empty">
        <strong>还没有站点</strong>
        先到「网站环境」安装 Nginx 与 PHP，然后点击右上角新建站点。
      </div>`}
    </div>
  `;

  const rows = el.querySelector('[data-role="rows"]');
  const drawRows = (keyword = '') => {
    if (!rows) return;
    const kw = keyword.trim().toLowerCase();
    const items = cache.items.filter((s) => !kw
      || s.name.toLowerCase().includes(kw)
      || s.domain.toLowerCase().includes(kw)
      || s.slug.includes(kw));
    rows.innerHTML = items.map(rowHtml).join('') || '<tr><td colspan="6" class="faint">没有匹配的站点</td></tr>';
    rows.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openDetail(Number(btn.dataset.open), ctx));
    });
    rows.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => toggleSite(Number(btn.dataset.toggle), ctx));
    });
    rows.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => removeSite(Number(btn.dataset.del), ctx));
    });
  };
  drawRows();

  el.querySelector('[data-role="search"]')?.addEventListener('input', (e) => drawRows(e.target.value));
  el.querySelector('[data-role="create"]')?.addEventListener('click', () => openCreate(ctx));
}

function rowHtml(s) {
  const cert = s.certStatus === 'issued'
    ? '<span class="badge ok">已启用</span>'
    : s.certStatus === 'expiring'
      ? '<span class="badge warn">即将过期</span>'
      : s.sslMode === 'acme'
        ? '<span class="badge err">待签发</span>'
        : '<span class="badge muted">未配置</span>';
  const env = s.appType === 'php'
    ? `PHP ${ui.esc(s.phpVersion || '')}`
    : s.appType === 'proxy'
      ? `反代 ${ui.esc(s.upstream || '')}`
      : '静态';
  const toggleLabel = s.desiredState === 'running' ? '停用' : '启用';
  return `<tr>
    <td>
      <div class="cell-main">${ui.esc(s.name)}</div>
      <div class="cell-sub mono">${ui.esc(s.slug)} · ${ui.esc(s.rootPath)}</div>
    </td>
    <td>
      <div class="mono">${ui.esc(s.domain)}</div>
      ${(s.aliases || []).length ? `<div class="cell-sub">+${s.aliases.length} 个别名</div>` : ''}
    </td>
    <td class="small dim"><span class="truncate" style="display:inline-block;max-width:190px" title="${env}">${env}</span></td>
    <td>${ui.badge(s.status)}${s.lastError ? `<div class="cell-sub" style="color:var(--danger)" title="${ui.esc(s.lastError)}">配置有误</div>` : ''}</td>
    <td>${cert}</td>
    <td class="actions">
      <button class="btn btn-sm" data-open="${s.id}">详情</button>
      <button class="btn btn-sm btn-ghost" data-toggle="${s.id}">${toggleLabel}</button>
      <button class="btn btn-sm btn-ghost" data-del="${s.id}" title="删除站点">删除</button>
    </td>
  </tr>`;
}

/* ------------------------------------------------------------------ create */

function openCreate(ctx) {
  const phpOptions = cache.runtimes.map((r) =>
    `<option value="${ui.esc(r.version)}" ${r.isDefault ? 'selected' : ''}>PHP ${ui.esc(r.version)}${r.isDefault ? '（默认）' : ''}</option>`).join('');
  const defaultRewrite = cache.settings['site.defaultRewrite'] || 'none';

  const { node, close } = ui.openModal({
    title: '新建站点',
    subtitle: '创建后会异步执行：建用户 → 建目录 → 写配置 → nginx -t → 重载',
    width: 640,
    body: `
      <div class="row">
        <div class="field"><label>站点名称</label><input class="input" data-f="name" placeholder="例如 公司官网" /></div>
        <div class="field"><label>站点标识</label><input class="input" data-f="slug" placeholder="留空自动生成，如 company-site" />
          <div class="help">用于目录 / 系统用户 / 配置文件命名，小写字母与中划线</div>
        </div>
      </div>
      <div class="field">
        <label>域名（多个用逗号或空格分隔）</label>
        <input class="input" data-f="domains" placeholder="example.com, www.example.com" />
        <div class="help">首个为主域名；域名需已解析到本机才能申请证书</div>
      </div>
      <div class="row">
        <div class="field"><label>应用类型</label>
          <select class="select" data-f="appType">
            <option value="php">PHP 站点</option>
            <option value="static">静态站点</option>
            <option value="proxy">反向代理（Node/Java 等）</option>
          </select>
        </div>
        <div class="field" data-role="php-field"><label>PHP 版本</label>
          <select class="select" data-f="phpVersion">${phpOptions || '<option value="">未安装 PHP</option>'}</select>
          ${phpOptions ? '' : '<div class="help" style="color:var(--warn)">请先在「网站环境」安装 PHP</div>'}
        </div>
      </div>
      <div class="field" data-role="proxy-field" hidden><label>反向代理地址</label>
        <input class="input" data-f="upstream" placeholder="http://127.0.0.1:3000" />
        <div class="help">仅支持本机地址，避免面板变成开放代理</div>
      </div>
      <div class="row">
        <div class="field"><label>伪静态规则</label>
          <select class="select" data-f="rewrite">
            ${['none|无', 'wordpress|WordPress', 'laravel|Laravel', 'thinkphp|ThinkPHP', 'discuz|Discuz'].map((o) => {
              const [v, l] = o.split('|');
              return `<option value="${v}" ${v === defaultRewrite ? 'selected' : ''}>${l}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="field"><label>上传大小限制（MB）</label><input class="input" data-f="body" type="number" value="64" min="1" max="4096" /></div>
      </div>
      <div class="check mb"><input type="checkbox" data-f="acme" id="acme" checked />
        <label for="acme">创建后自动申请 Let's Encrypt 证书并启用 HTTPS</label>
      </div>
      <div class="field"><label>备注（可选）</label><input class="input" data-f="remark" placeholder="用途、负责人等" /></div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
    `,
    footer: '<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" data-role="submit">创建站点</button>',
  });

  const appTypeEl = node.querySelector('[data-f="appType"]');
  const syncType = () => {
    const v = appTypeEl.value;
    node.querySelector('[data-role="php-field"]').hidden = v !== 'php';
    node.querySelector('[data-role="proxy-field"]').hidden = v !== 'proxy';
  };
  appTypeEl.addEventListener('change', syncType);
  syncType();

  node.querySelector('[data-role="submit"]').addEventListener('click', async () => {
    const msg = node.querySelector('[data-role="msg"]');
    const btn = node.querySelector('[data-role="submit"]');
    msg.textContent = '';
    const domains = node.querySelector('[data-f="domains"]').value
      .split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean);
    const body = {
      name: node.querySelector('[data-f="name"]').value.trim(),
      slug: node.querySelector('[data-f="slug"]').value.trim() || undefined,
      domains,
      appType: appTypeEl.value,
      phpVersion: node.querySelector('[data-f="phpVersion"]')?.value || undefined,
      upstream: node.querySelector('[data-f="upstream"]')?.value.trim() || undefined,
      sslMode: node.querySelector('[data-f="acme"]').checked ? 'acme' : 'none',
      remark: node.querySelector('[data-f="remark"]').value.trim(),
      settings: {
        rewrite: node.querySelector('[data-f="rewrite"]').value,
        clientMaxBodySizeMb: Number(node.querySelector('[data-f="body"]').value) || 64,
      },
    };
    if (!body.name) { msg.textContent = '请填写站点名称'; return; }
    if (!domains.length) { msg.textContent = '请填写至少一个域名'; return; }

    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      const res = await api('/sites', { method: 'POST', body });
      close();
      ui.toast('站点已创建，任务开始执行');
      ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
      ctx.refresh();
    } catch (err) {
      msg.textContent = err.message;
      btn.disabled = false;
      btn.textContent = '创建站点';
    }
  });
}

/* ------------------------------------------------------------------ detail */

async function openDetail(id, ctx) {
  let detail;
  try {
    detail = await api(`/sites/${id}`);
  } catch (err) {
    ui.toast(err.message, 'err');
    return;
  }

  const drawer = ui.openDrawer({
    title: ui.esc(detail.name),
    subtitle: `<span class="mono">${ui.esc(detail.domain)}</span> · ${ui.esc(detail.slug)}`,
    body: `
      <div class="tabs">
        <div class="tab active" data-tab="info">概览</div>
        <div class="tab" data-tab="config">配置预览</div>
        <div class="tab" data-tab="logs">运行日志</div>
        <div class="tab" data-tab="cert">SSL 证书</div>
      </div>
      <div data-role="panel"></div>
    `,
    footer: `<button class="btn btn-ghost" data-role="reload">重载服务</button>
      <button class="btn" data-role="toggle">${detail.desiredState === 'running' ? '停用站点' : '启用站点'}</button>
      <button class="btn btn-danger" data-role="delete">删除站点</button>`,
  });

  const panel = drawer.node.querySelector('[data-role="panel"]');
  const tabs = drawer.node.querySelectorAll('[data-tab]');

  const showInfo = () => {
    const s = detail;
    panel.innerHTML = `
      ${s.lastError ? `<div class="card tight mb" style="border-color:rgba(255,95,86,.4)">
        <div class="small" style="color:#ff8b84"><strong>最近一次错误：</strong>${ui.esc(s.lastError)}</div></div>` : ''}
      <dl class="kv">
        <dt>状态</dt><dd>${ui.badge(s.status)} ${s.desiredState === 'stopped' ? '<span class="badge muted">期望停用</span>' : ''}</dd>
        <dt>应用类型</dt><dd>${ui.esc(s.appType)}${s.phpVersion ? ` / PHP ${ui.esc(s.phpVersion)}` : ''}</dd>
        <dt>主域名</dt><dd>${ui.esc(s.domain)}</dd>
        <dt>域名别名</dt><dd>${(s.aliases || []).map(ui.esc).join(', ') || '—'}</dd>
        ${s.upstream ? `<dt>反向代理</dt><dd>${ui.esc(s.upstream)}</dd>` : ''}
        <dt>站点目录</dt><dd>${ui.esc(s.rootPath)}/public</dd>
        <dt>系统用户</dt><dd>${ui.esc(s.siteUser)}</dd>
        <dt>伪静态</dt><dd>${ui.esc(s.settings?.rewrite || 'none')}</dd>
        <dt>上传限制</dt><dd>${ui.esc(s.settings?.clientMaxBodySizeMb || 64)} MB</dd>
        ${s.appType === 'php' ? `<dt>PHP 进程数</dt><dd>pm.max_children = ${ui.esc(s.settings?.maxChildren || 10)}</dd>` : ''}
        <dt>备注</dt><dd>${ui.esc(s.remark) || '—'}</dd>
        <dt>创建时间</dt><dd>${ui.fmtDate(s.createdAt)}</dd>
      </dl>
      <div class="sec-title mt">最近任务</div>
      ${(s.recentTasks || []).length ? `<div class="list">${s.recentTasks.map((t) => `
        <div class="list-item" data-task="${ui.esc(t.id)}" style="cursor:pointer">
          <div class="grow"><div class="small truncate">${ui.esc(t.title)}</div>
            <div class="cell-sub">${ui.fmtRelative(t.createdAt)}</div></div>
          ${ui.badge(t.status)}
        </div>`).join('')}</div>` : '<div class="small faint">暂无任务</div>'}
    `;
    panel.querySelectorAll('[data-task]').forEach((row) => {
      row.addEventListener('click', async () => {
        try { ctx.openTask(await api(`/tasks/${row.dataset.task}`)); } catch (err) { ui.toast(err.message, 'err'); }
      });
    });
  };

  const showConfig = async () => {
    panel.innerHTML = '<div class="skeleton" style="width:60%"></div>';
    try {
      const cfg = await api(`/sites/${id}/config`);
      panel.innerHTML = `
        <div class="small faint mb">以下内容与 agent 实际落盘完全一致（同一渲染器生成）</div>
        <div class="sec-title">nginx vhost</div>
        <pre class="log">${ui.esc(cfg.vhost)}</pre>
        ${cfg.pool ? `<div class="sec-title mt">php-fpm pool</div><pre class="log">${ui.esc(cfg.pool)}</pre>` : ''}
      `;
    } catch (err) {
      panel.innerHTML = `<div class="empty"><strong>配置渲染失败</strong>${ui.esc(err.message)}</div>`;
    }
  };

  const showLogs = async () => {
    panel.innerHTML = `
      <div class="log-toolbar">
        <select class="select" data-role="log-type" style="width:150px">
          <option value="access">访问日志</option>
          <option value="error">错误日志</option>
          <option value="php">PHP 错误日志</option>
        </select>
        <select class="select" data-role="log-lines" style="width:120px">
          <option value="100">最近 100 行</option>
          <option value="300" selected>最近 300 行</option>
          <option value="800">最近 800 行</option>
        </select>
        <button class="btn btn-sm" data-role="log-refresh">刷新</button>
        <span class="small faint" data-role="log-meta"></span>
      </div>
      <pre class="log" data-role="log-body">加载中…</pre>
    `;
    const load = async () => {
      const type = panel.querySelector('[data-role="log-type"]').value;
      const lines = panel.querySelector('[data-role="log-lines"]').value;
      const body = panel.querySelector('[data-role="log-body"]');
      const meta = panel.querySelector('[data-role="log-meta"]');
      body.textContent = '加载中…';
      try {
        const res = await api(`/sites/${id}/logs?type=${type}&lines=${lines}`);
        body.textContent = (res.lines || []).join('\n') || '（暂无日志）';
        meta.textContent = res.file ? res.file : '';
        body.scrollTop = body.scrollHeight;
      } catch (err) {
        body.textContent = `读取失败：${err.message}`;
      }
    };
    panel.querySelector('[data-role="log-refresh"]').addEventListener('click', load);
    panel.querySelector('[data-role="log-type"]').addEventListener('change', load);
    panel.querySelector('[data-role="log-lines"]').addEventListener('change', load);
    await load();
  };

  const showCert = async () => {
    panel.innerHTML = '<div class="skeleton" style="width:50%"></div>';
    const certsRes = await api(`/certificates?siteId=${id}`).catch(() => []);
    const list = Array.isArray(certsRes) ? certsRes : [];
    panel.innerHTML = `
      <div class="card tight mb">
        <div class="flex-between">
          <div>
            <div class="cell-main">${list.length ? '已配置证书' : '尚未配置证书'}</div>
            <div class="cell-sub">建议使用 Let's Encrypt 免费证书，到期前自动续期</div>
          </div>
          <button class="btn btn-primary btn-sm" data-role="issue">${list.length ? '重新申请' : '申请证书'}</button>
        </div>
      </div>
      ${list.map((c) => `
        <div class="list-item mb">
          <div class="grow">
            <div class="cell-main mono">${ui.esc(c.domain)}</div>
            <div class="cell-sub">${ui.esc(c.issuer || '')} · 到期 ${ui.fmtDate(c.notAfter, false)}（${c.daysLeft ?? '—'} 天）</div>
            ${c.lastError ? `<div class="cell-sub" style="color:#ff8b84">${ui.esc(c.lastError)}</div>` : ''}
          </div>
          <div class="inline">
            ${ui.badge(c.status)}
            <button class="btn btn-sm" data-renew="${c.id}">续期</button>
          </div>
        </div>`).join('')}
      <div class="small faint mt">证书文件由 agent 写入 /etc/letsencrypt 或 /etc/xfmpanel/certs，站点配置会在签发后自动重建。</div>
    `;

    panel.querySelector('[data-role="issue"]').addEventListener('click', () => issueCert(detail, ctx, close));
    panel.querySelectorAll('[data-renew]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api(`/certificates/${btn.dataset.renew}/renew`, { method: 'POST' });
          close();
          ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
        } catch (err) { ui.toast(err.message, 'err'); }
      });
    });
  };

  const renderers = { info: showInfo, config: showConfig, logs: showLogs, cert: showCert };
  const activate = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    renderers[name]();
  };
  tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));
  activate('info');

  drawer.node.querySelector('[data-role="reload"]').addEventListener('click', async () => {
    try {
      const res = await api(`/sites/${id}/reload`, { method: 'POST' });
      close();
      ui.toast('已开始重载服务');
      ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
    } catch (err) { ui.toast(err.message, 'err'); }
  });

  drawer.node.querySelector('[data-role="toggle"]').addEventListener('click', () => {
    close();
    toggleSite(id, ctx);
  });

  drawer.node.querySelector('[data-role="delete"]').addEventListener('click', () => {
    close();
    removeSite(id, ctx);
  });
}

async function issueCert(site, ctx, closeDrawer) {
  const canWrite = true;
  const { node, close } = ui.openModal({
    title: '申请 SSL 证书',
    subtitle: `站点 ${site.domain}`,
    body: `
      <div class="field"><label>域名（逗号分隔）</label>
        <input class="input" data-f="domains" value="${ui.esc(site.domains.join(', '))}" /></div>
      <div class="check mb"><input type="checkbox" id="force" data-f="force" />
        <label for="force">强制重新签发（已有证书时覆盖）</label></div>
      <div class="small faint">使用 HTTP-01 webroot 校验：需要域名已解析到本机且 80 端口可访问。签发完成后会自动重建 nginx 配置并启用 HTTPS。</div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
    `,
    footer: '<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" data-role="ok">开始申请</button>',
    width: 480,
  });
  node.querySelector('[data-role="ok"]').addEventListener('click', async () => {
    const domains = node.querySelector('[data-f="domains"]').value.split(/[,，\s]+/).filter(Boolean);
    try {
      const res = await api('/certificates/issue', {
        method: 'POST',
        body: { siteId: site.id, domains, force: node.querySelector('[data-f="force"]').checked },
      });
      close();
      closeDrawer?.();
      ui.toast('证书申请任务已创建');
      ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
    } catch (err) {
      node.querySelector('[data-role="msg"]').textContent = err.message;
    }
  });
}

/* ------------------------------------------------------------------ actions */

async function toggleSite(id, ctx) {
  const site = cache.items.find((s) => s.id === id) || (await api(`/sites/${id}`));
  const next = site.desiredState === 'running' ? 'stopped' : 'active';
  try {
    const res = await api(`/sites/${id}/state`, { method: 'POST', body: { status: next } });
    ui.toast(next === 'active' ? '正在启用站点' : '正在停用站点');
    ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
    ctx.refresh();
  } catch (err) {
    ui.toast(err.message, 'err');
  }
}

async function removeSite(id, ctx) {
  const site = cache.items.find((s) => s.id === id) || { name: `#${id}`, domain: '' };
  const ok = await ui.confirmDialog({
    title: `删除站点「${site.name}」`,
    message: '将移除 nginx 配置与 PHP-FPM pool，并按策略备份站点文件。此操作不可撤销。',
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api(`/sites/${id}?keepFiles=1&backup=1`, { method: 'DELETE' });
    ui.toast('删除任务已创建');
    ctx.openTask(res.task, { onFinished: () => ctx.refresh() });
    ctx.refresh();
  } catch (err) {
    ui.toast(err.message, 'err');
  }
}
