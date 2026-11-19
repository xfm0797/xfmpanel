/**
 * UI 基础件：转义、格式化、Toast、Modal、Drawer、任务日志流。
 */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

export function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 60_000) return '刚刚';
  if (abs < 3600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86400_000) return `${Math.round(abs / 3600_000)} 小时${suffix}`;
  return `${Math.round(abs / 86400_000)} 天${suffix}`;
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

const STATUS_MAP = {
  active: ['ok', '运行中'],
  stopped: ['muted', '已停用'],
  pending: ['info', '处理中'],
  error: ['err', '异常'],
  deleting: ['warn', '删除中'],
  queued: ['info', '排队中'],
  running: ['info', '执行中'],
  success: ['ok', '成功'],
  failed: ['err', '失败'],
  canceled: ['muted', '已取消'],
  issued: ['ok', '已签发'],
  expiring: ['warn', '即将过期'],
  expired: ['err', '已过期'],
  revoked: ['muted', '已吊销'],
  not_installed: ['muted', '未安装'],
  installing: ['info', '安装中'],
  installed: ['ok', '已安装'],
};

export function badge(status, label) {
  const [cls, text] = STATUS_MAP[status] || ['muted', status];
  return `<span class="badge ${cls}">${esc(label || text)}</span>`;
}

export function toast(message, type = 'ok', ttl = 4200) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'ok' ? '✓' : type === 'err' ? '!' : 'i';
  el.innerHTML = `<span class="ico">${icon}</span><span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  }, ttl);
}

/* ------------------------------------------------------------------ overlay */

function mountOverlay(html, { onClose } = {}) {
  const root = document.getElementById('overlay-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.addEventListener('click', () => close());
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstElementChild;
  root.append(scrim, node);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    scrim.remove();
    node.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  node.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { node, close };
}

export function openModal({ title, subtitle = '', body = '', footer = '', width = 560 }) {
  const { node, close } = mountOverlay(`
    <div class="modal" style="width:min(${width}px,94vw)">
      <div class="modal-head">
        <div style="flex:1">
          <h2>${esc(title)}</h2>
          ${subtitle ? `<div class="faint small">${esc(subtitle)}</div>` : ''}
        </div>
        <button class="btn btn-icon btn-ghost" data-close title="关闭">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>
  `);
  return { node, close };
}

export function confirmDialog({ title, message, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const { node, close } = openModal({
      title,
      body: `<p class="dim" style="margin:0">${esc(message)}</p>`,
      footer: `
        <button class="btn btn-ghost" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>
      `,
      width: 460,
    });
    node.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      settled = true;
      close();
      resolve(act === 'ok');
    });
    const interval = setInterval(() => {
      if (!document.body.contains(node) && !settled) {
        clearInterval(interval);
        resolve(false);
      } else if (settled) {
        clearInterval(interval);
      }
    }, 300);
  });
}

export function openDrawer({ title, subtitle = '', body = '', footer = '' }) {
  const { node, close } = mountOverlay(`
    <div class="drawer">
      <div class="drawer-head">
        <div style="flex:1;min-width:0">
          <h2>${esc(title)}</h2>
          ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
        </div>
        <button class="btn btn-icon btn-ghost" data-close title="关闭">✕</button>
      </div>
      <div class="drawer-body">${body}</div>
      ${footer ? `<div class="drawer-foot">${footer}</div>` : ''}
    </div>
  `);
  return { node, close, body: node.querySelector('.drawer-body'), head: node.querySelector('.drawer-head h2') };
}

/* ------------------------------------------------------------------ task stream */

const LEVEL_CLASS = { info: 'lv-info', warn: 'lv-warn', error: 'lv-error', success: 'lv-success' };

export function renderLogLine(ev) {
  const time = fmtDate(ev.at, true).slice(11);
  const cls = LEVEL_CLASS[ev.level] || 'lv-meta';
  return `<span class="${cls}">${esc(time)}  ${esc(ev.message)}</span>\n`;
}

/**
 * 订阅任务事件流：先补齐历史事件，再实时追加。
 * @returns {{close:()=>void}}
 */
export function streamTask(taskId, { onEvent, onDone, after = 0 } = {}) {
  const source = new EventSource(`/api/v1/tasks/${taskId}/events?after=${after}`);
  let closed = false;

  source.addEventListener('log', (ev) => {
    try { onEvent?.(JSON.parse(ev.data)); } catch { /* ignore */ }
  });
  source.addEventListener('meta', (ev) => {
    try { onEvent?.({ seq: -2, level: 'meta', message: `任务 ${JSON.parse(ev.data).title}`, at: new Date().toISOString() }); } catch { /* ignore */ }
  });
  source.addEventListener('done', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* ignore */ }
    close();
    onDone?.(data);
  });
  source.addEventListener('error', () => {
    // 浏览器会自动重连；超过一定次数后由 onDone 兜底关闭
    if (source.readyState === EventSource.CLOSED) {
      close();
      onDone?.({ status: 'unknown' });
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    source.close();
  }
  return { close };
}

/** 打开任务日志抽屉（全局复用） */
export function openTaskDrawer(task, { onFinished } = {}) {
  const body = `
    <div class="flex-between mb">
      <div class="inline">
        ${badge(task.status)}
        <span class="faint small">${esc(task.typeLabel || task.type)}</span>
      </div>
      <div class="small faint" data-role="pct">${task.progress || 0}%</div>
    </div>
    <div class="progress mb"><span style="width:${task.progress || 0}%" data-role="bar"></span></div>
    <pre class="log" data-role="log"></pre>
  `;
  const drawer = openDrawer({
    title: task.title || '任务',
    subtitle: `任务 ID：<code>${esc(task.id)}</code>`,
    body,
    footer: task.status === 'queued'
      ? '<button class="btn btn-ghost" data-role="cancel">取消任务</button><button class="btn" data-close>后台运行</button>'
      : task.status === 'running'
        ? '<span class="small faint" style="margin-right:auto">任务执行中，暂不支持取消</span><button class="btn" data-close>后台运行</button>'
        : '<button class="btn" data-close>关闭</button>',
  });

  const logEl = drawer.node.querySelector('[data-role="log"]');
  const barEl = drawer.node.querySelector('[data-role="bar"]');
  const pctEl = drawer.node.querySelector('[data-role="pct"]');
  const cancelBtn = drawer.node.querySelector('[data-role="cancel"]');

  const push = (ev) => {
    logEl.insertAdjacentHTML('beforeend', renderLogLine(ev));
    logEl.scrollTop = logEl.scrollHeight;
    const m = /^\[(\d+)%\]/.exec(ev.message || '');
    if (m) {
      barEl.style.width = `${m[1]}%`;
      pctEl.textContent = `${m[1]}%`;
    }
  };

  const stream = streamTask(task.id, {
    onEvent: push,
    onDone: (data) => {
      if (cancelBtn) cancelBtn.remove();
      barEl.style.width = '100%';
      pctEl.textContent = data.status === 'success' ? '完成' : data.status === 'failed' ? '失败' : data.status;
      logEl.insertAdjacentHTML('beforeend', renderLogLine({
        level: data.status === 'success' ? 'success' : 'error',
        message: data.status === 'success' ? '—— 任务完成 ——' : `—— 任务结束：${data.status}${data.error ? ` / ${data.error}` : ''} ——`,
        at: new Date().toISOString(),
      }));
      logEl.scrollTop = logEl.scrollHeight;
      onFinished?.(data);
    },
  });

  cancelBtn?.addEventListener('click', async () => {
    try {
      await import('./api.js').then(({ api }) => api(`/tasks/${task.id}/cancel`, { method: 'POST' }));
      toast('已请求取消任务', 'warn');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  return { drawer, stream };
}

export function icon(paths) {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
