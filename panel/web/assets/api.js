/**
 * API 客户端：统一处理 CSRF、错误信封、401 跳登录。
 */

export const state = {
  me: null,
  csrf: '',
  panel: {},
  alertsOpen: 0,
  refreshing: false,
};

export class ApiError extends Error {
  constructor(message, { code, status, field, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.field = field;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;

  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('无法连接面板服务，请检查网络或面板进程', { code: 'NETWORK' });
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (!res.ok || json?.ok === false) {
    const err = new ApiError(json?.error?.message || `请求失败（HTTP ${res.status}）`, {
      code: json?.error?.code || `HTTP_${res.status}`,
      status: res.status,
      field: json?.error?.field,
      details: json?.error?.details,
    });
    if (res.status === 401) {
      state.me = null;
      window.dispatchEvent(new CustomEvent('xfm:unauthorized'));
    }
    throw err;
  }
  return json?.data ?? null;
}
