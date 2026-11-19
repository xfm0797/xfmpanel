/**
 * XFMPanel 控制台入口：登录、外壳布局、路由、全局快捷操作。
 */

import { api, state } from './api.js';
import * as ui from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as sites from './views/sites.js';
import * as runtimes from './views/runtimes.js';
import * as certs from './views/certs.js';
import * as tasks from './views/tasks.js';
import * as logs from './views/logs.js';
import * as alerts from './views/alerts.js';
import * as users from './views/users.js';
import * as settings from './views/settings.js';

const VIEWS = {
  dashboard: { label: '概览', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', mod: dashboard },
  runtimes: { label: '网站环境', icon: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2.5"/>', mod: runtimes, perm: 'runtime:read' },
  sites: { label: '站点管理', icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/>', mod: sites, perm: 'site:read' },
  certs: { label: 'SSL 证书', icon: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>', mod: certs, perm: 'cert:read' },
  tasks: { label: '任务中心', icon: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>', mod: tasks, perm: 'task:read' },
  logs: { label: '日志审计', icon: '<path d="M4 5h16v14H4z"/><path d="M7 9h8M7 13h10M7 17h6"/>', mod: logs, perm: 'log:read' },
  alerts: { label: '告警中心', icon: '<path d="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9z"/><path d="M10.5 20a2 2 0 003 0"/>', mod: alerts, perm: 'alert:read' },
  users: { label: '系统用户', icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/>', mod: users, perm: 'user:read' },
  settings: { label: '系统设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>', mod: settings, perm: 'settings:read' },
};

const NAV_GROUPS = [
  { label: '运行', keys: ['dashboard', 'runtimes', 'sites'] },
  { label: '安全与审计', keys: ['certs', 'alerts', 'logs'] },
  { label: '系统', keys: ['tasks', 'users', 'settings'] },
];

let currentKey = 'dashboard';

function hasPerm(perm) {
  if (!perm) return true;
  const perms = state.me?.permissions || [];
  return perms.includes('*') || perms.includes(perm);
}

function focusKey() {
  const key = (location.hash || '#/dashboard').replace(/^#\/?/, '') || 'dashboard';
  return VIEWS[key] ? key : 'dashboard';
}

/* ------------------------------------------------------------------ login */

function renderLogin(message = '') {
  document.getElementById('root').hidden = true;
  document.getElementById('boot').hidden = true;
  let host = document.getElementById('login-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'login-host';
    document.body.appendChild(host);
  }
  host.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="brand">
          <div class="brand-mark">XFM</div>
          <div>
            <div class="brand-name">XFMPanel</div>
            <div class="brand-ver">主机管理面板</div>
          </div>
        </div>
        <div class="login-title">登录控制台</div>
        <div class="login-sub">请使用管理员账号登录，所有操作都会被审计</div>
        <form id="login-form">
          <div class="field">
            <label for="lg-user">用户名</label>
            <input class="input" id="lg-user" name="username" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="lg-pass">密码</label>
            <input class="input" id="lg-pass" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div id="login-err" class="small" style="color:var(--danger);min-height:18px;margin-bottom:8px">${ui.esc(message)}</div>
          <button class="btn btn-primary" type="submit" style="width:100%;padding:9px">登录</button>
        </form>
        <div class="login-foot">
          连续 5 次失败将锁定 15 分钟<br />忘记密码可在服务器执行 <code>npm run reset-admin</code>
        </div>
      </div>
    </div>
  `;
  host.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button');
    const errBox = host.querySelector('#login-err');
    btn.disabled = true;
    btn.textContent = '登录中…';
    errBox.textContent = '';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { username: form.username.value.trim(), password: form.password.value },
      });
      state.me = data.user;
      state.csrf = data.csrfToken;
      host.remove();
      document.getElementById('boot').hidden = true;
      await bootShell();
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });
}

/* ------------------------------------------------------------------ shell */

function shellHtml() {
  const navGroups = NAV_GROUPS.map((group) => {
    const items = group.keys.filter((k) => hasPerm(VIEWS[k].perm)).map((k) => {
      const v = VIEWS[k];
      return `<div class="nav-item" data-nav="${k}">
        ${ui.icon(v.icon)}<span>${v.label}</span>
        ${k === 'alerts' ? '<span class="nav-badge" data-role="alert-count" hidden>0</span>' : ''}
      </div>`;
    }).join('');
    return items ? `<div class="nav-group-label">${group.label}</div>${items}` : '';
  }).join('');

  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">XFM</div>
          <div>
            <div class="brand-name">XFMPanel</div>
            <div class="brand-ver">v${ui.esc(state.panel.version || '1.0.1')}</div>
          </div>
        </div>
        <nav class="nav">${navGroups}</nav>
        <div class="sidebar-foot">
          <div><span class="dot" data-role="agent-dot"></span><span data-role="agent-text">检测中…</span></div>
          <div class="truncate" data-role="host"></div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div>
            <h1 data-role="view-title">概览</h1>
            <div class="sub" data-role="view-sub"></div>
          </div>
          <div class="topbar-actions">
            <button class="btn btn-sm btn-ghost" data-role="refresh" title="刷新当前页">↻ 刷新</button>
            <div class="user-chip" data-role="user">
              <div class="avatar">${ui.esc((state.me?.displayName || state.me?.username || '?').slice(0, 1).toUpperCase())}</div>
              <div class="small">${ui.esc(state.me?.username || '')}</div>
            </div>
          </div>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>
  `;
}

async function bootShell() {
  const root = document.getElementById('root');
  root.hidden = false;
  root.innerHTML = shellHtml();

  root.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      location.hash = `#/${nav.dataset.nav}`;
      return;
    }
    if (e.target.closest('[data-role="refresh"]')) {
      navigate({ force: true });
      return;
    }
    if (e.target.closest('[data-role="user"]')) openAccountDialog();
  });

  window.addEventListener('hashchange', () => navigate());
  await refreshChrome();
  await navigate({ force: true });
}

async function refreshChrome() {
  try {
    const overview = await api('/system/overview');
    state.panel = { ...state.panel, ...overview.panel };
    state.alertsOpen = overview.alerts?.open || 0;
    state.overview = overview;

    const dot = document.querySelector('[data-role="agent-dot"]');
    const text = document.querySelector('[data-role="agent-text"]');
    if (dot && text) {
      const ok = overview.agent?.ok;
      dot.className = `dot ${ok ? 'ok' : 'bad'}`;
      text.textContent = ok ? `agent 正常 · ${overview.agent.mode}` : 'agent 离线';
    }
    const hostEl = document.querySelector('[data-role="host"]');
    if (hostEl) {
      hostEl.textContent = overview.system?.hostname
        ? `${overview.system.hostname} · ${overview.system.distro || ''}`
        : overview.panel?.hostname || '';
    }
    const badgeEl = document.querySelector('[data-role="alert-count"]');
    if (badgeEl) {
      badgeEl.hidden = state.alertsOpen === 0;
      badgeEl.textContent = String(state.alertsOpen);
    }
  } catch (err) {
    if (err.status !== 401) console.warn('概览刷新失败', err.message);
  }
}

function openAccountDialog() {
  const { node, close } = ui.openModal({
    title: '账号',
    subtitle: `${ui.esc(state.me?.displayName || '')} · ${ui.esc(state.me?.username || '')}`,
    body: `
      <dl class="kv mb">
        <dt>角色</dt><dd>${ui.esc(state.me?.role || '')}</dd>
        <dt>最近登录</dt><dd>${ui.fmtDate(state.me?.lastLoginAt)}</dd>
      </dl>
      <div class="sec-title">修改密码</div>
      <div class="field"><label>原密码</label><input class="input" type="password" data-f="old" autocomplete="current-password" /></div>
      <div class="field"><label>新密码</label><input class="input" type="password" data-f="new" autocomplete="new-password" />
        <div class="help">至少 10 位，需包含字母与数字</div>
      </div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
    `,
    footer: `
      <button class="btn btn-ghost" data-role="logout">退出登录</button>
      <button class="btn btn-primary" data-role="save">更新密码</button>
    `,
    width: 460,
  });

  node.querySelector('[data-role="logout"]').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.me = null;
    close();
    document.getElementById('root').hidden = true;
    document.getElementById('root').innerHTML = '';
    renderLogin('已退出登录');
  });

  node.querySelector('[data-role="save"]').addEventListener('click', async () => {
    const oldPassword = node.querySelector('[data-f="old"]').value;
    const newPassword = node.querySelector('[data-f="new"]').value;
    const msg = node.querySelector('[data-role="msg"]');
    try {
      await api('/auth/password', { method: 'POST', body: { oldPassword, newPassword } });
      ui.toast('密码已更新，其它会话已失效');
      close();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

/* ------------------------------------------------------------------ router */

const ctx = {
  api,
  state,
  ui,
  refresh: () => navigate({ force: true }),
  refreshChrome,
  go: (hash) => { location.hash = hash; },
  openTask: (task, opts) => {
    ui.openTaskDrawer(task, {
      onFinished: () => {
        refreshChrome();
        navigate({ force: true });
        opts?.onFinished?.();
      },
    });
  },
};

async function navigate({ force = false } = {}) {
  const key = focusKey();
  const view = VIEWS[key];
  if (!view) return;
  if (!hasPerm(view.perm)) {
    document.getElementById('view').innerHTML = '<div class="empty"><strong>没有访问权限</strong>请联系超级管理员分配角色</div>';
    return;
  }
  if (key === currentKey && !force && !location.hash) {
    // 首次进入时也要渲染
  }
  currentKey = key;

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === key);
  });
  document.querySelector('[data-role="view-title"]').textContent = view.label;
  document.querySelector('[data-role="view-sub"]').textContent = '';

  const el = document.getElementById('view');
  el.innerHTML = '<div class="card"><div class="skeleton" style="width:40%"></div><div class="skeleton mt" style="width:70%"></div><div class="skeleton mt" style="width:55%"></div></div>';
  try {
    await view.mod.render(el, ctx);
  } catch (err) {
    if (err.status === 401) return;
    console.error(err);
    el.innerHTML = `<div class="card"><div class="empty"><strong>加载失败</strong>${ui.esc(err.message)}</div></div>`;
  }
}

/* ------------------------------------------------------------------ boot */

window.addEventListener('xfm:unauthorized', () => {
  const host = document.getElementById('login-host');
  if (!host) {
    document.getElementById('root').innerHTML = '';
    renderLogin('登录状态已失效，请重新登录');
  }
});

async function boot() {
  try {
    const me = await api('/auth/me');
    state.me = me.user;
    state.csrf = me.csrfToken;
    state.panel = { ...me.settings, version: '1.0.1' };
    document.getElementById('boot').hidden = true;
    await bootShell();
  } catch (err) {
    if (err.status === 401 || err.code === 'AUTH_REQUIRED') {
      const h = await fetch('/api/v1/system/health').then((r) => r.json()).catch(() => null);
      if (h?.data?.panel === 'ok') {
        // 面板已就绪，等待登录
      }
      renderLogin();
    } else {
      document.getElementById('boot').innerHTML =
        `<div class="boot-logo">XFM</div><div class="boot-text">${ui.esc(err.message)}</div>`;
    }
  }
}

boot();
