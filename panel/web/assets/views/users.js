/**
 * 系统用户与角色（仅超级管理员可见）。
 */

import { api, state } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  const data = await api('/users');
  const roles = data.roles || [];

  el.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>用户</h2>
        <span class="hint">共 ${data.items.length} 个账号</span>
        <div class="spacer"></div>
        <button class="btn btn-primary" data-role="create">+ 新建用户</button>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>最近登录</th><th>创建时间</th><th class="right">操作</th></tr></thead>
        <tbody>${data.items.map((u) => `
          <tr>
            <td><div class="cell-main">${ui.esc(u.displayName || u.username)}</div>
              <div class="cell-sub mono">${ui.esc(u.username)}</div></td>
            <td>${roleBadge(u.role, roles)}</td>
            <td>${u.status === 'active' ? '<span class="badge ok">启用</span>' : '<span class="badge muted">禁用</span>'}</td>
            <td class="small faint">${u.lastLoginAt ? `${ui.fmtDate(u.lastLoginAt)}<div class="cell-sub">${ui.esc(u.lastLoginIp || '')}</div>` : '—'}</td>
            <td class="small faint">${ui.fmtDate(u.createdAt, false)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-edit="${u.id}">编辑</button>
              ${u.id === state.me.id ? '' : `<button class="btn btn-sm btn-ghost" data-del="${u.id}">删除</button>`}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card mt">
      <div class="card-head"><h2>角色权限</h2><div class="spacer"></div><span class="hint">最小权限原则：日常运维使用 operator</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>角色</th><th>权限</th></tr></thead>
        <tbody>${roles.map((r) => `
          <tr><td class="cell-main">${ui.esc(r.label)} <span class="faint mono small">${ui.esc(r.name)}</span></td>
            <td class="small dim mono">${r.permissions.map(ui.esc).join(' · ')}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;

  el.querySelector('[data-role="create"]').addEventListener('click', () => openForm(null, roles, ctx));
  el.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = data.items.find((u) => String(u.id) === btn.dataset.edit);
      openForm(user, roles, ctx);
    });
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const user = data.items.find((u) => String(u.id) === btn.dataset.del);
      const ok = await ui.confirmDialog({
        title: `删除用户 ${user.username}`,
        message: '删除后该账号的会话会立即失效，操作不可撤销。',
        danger: true,
        confirmText: '删除',
      });
      if (!ok) return;
      try {
        await api(`/users/${user.id}`, { method: 'DELETE' });
        ui.toast('用户已删除');
        ctx.refresh();
      } catch (err) { ui.toast(err.message, 'err'); }
    });
  });
}

function roleBadge(role, roles) {
  const r = roles.find((x) => x.name === role);
  const cls = role === 'owner' ? 'info' : role === 'admin' ? 'ok' : role === 'operator' ? 'muted' : 'muted';
  return `<span class="badge ${cls}">${ui.esc(r?.label || role)}</span>`;
}

function openForm(user, roles, ctx) {
  const isEdit = Boolean(user);
  const { node, close } = ui.openModal({
    title: isEdit ? `编辑用户 ${user.username}` : '新建用户',
    body: `
      ${isEdit ? '' : `<div class="field"><label>用户名</label><input class="input" data-f="username" placeholder="字母数字下划线" /></div>`}
      <div class="field"><label>显示名称</label><input class="input" data-f="displayName" value="${ui.esc(user?.displayName || '')}" /></div>
      <div class="row">
        <div class="field"><label>角色</label>
          <select class="select" data-f="role">${roles.map((r) =>
            `<option value="${ui.esc(r.name)}" ${user?.role === r.name ? 'selected' : ''}>${ui.esc(r.label)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>状态</label>
          <select class="select" data-f="status">
            <option value="active" ${user?.status !== 'disabled' ? 'selected' : ''}>启用</option>
            <option value="disabled" ${user?.status === 'disabled' ? 'selected' : ''}>禁用</option>
          </select>
        </div>
      </div>
      <div class="field"><label>${isEdit ? '重置密码（留空不修改）' : '密码'}</label>
        <input class="input" type="password" data-f="password" autocomplete="new-password" />
        <div class="help">至少 10 位，需包含字母与数字</div></div>
      <div class="small" data-role="msg" style="min-height:18px;color:var(--danger)"></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>取消</button>
      <button class="btn btn-primary" data-role="ok">${isEdit ? '保存' : '创建'}</button>`,
    width: 480,
  });

  node.querySelector('[data-role="ok"]').addEventListener('click', async () => {
    const password = node.querySelector('[data-f="password"]').value;
    const payload = {
      displayName: node.querySelector('[data-f="displayName"]').value.trim(),
      role: node.querySelector('[data-f="role"]').value,
      status: node.querySelector('[data-f="status"]').value,
    };
    if (password) payload.password = password;
    try {
      if (isEdit) {
        await api(`/users/${user.id}`, { method: 'PATCH', body: payload });
        ui.toast('用户已更新');
      } else {
        payload.username = node.querySelector('[data-f="username"]').value.trim();
        await api('/users', { method: 'POST', body: payload });
        ui.toast('用户已创建');
      }
      close();
      ctx.refresh();
    } catch (err) {
      node.querySelector('[data-role="msg"]').textContent = err.message;
    }
  });
}
