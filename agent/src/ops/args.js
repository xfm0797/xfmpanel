/**
 * agent 参数校验小工具。所有 op 的入参都必须先经过这里。
 * 校验失败统一抛 ArgError（code=BAD_ARGS），由 agent 主循环转成 error 帧。
 */

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
    this.code = 'BAD_ARGS';
  }
}

export function s(value, { field, min = 1, max = 255, pattern } = {}) {
  if (typeof value !== 'string') throw new ArgError(`${field} 必须是字符串`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new ArgError(`${field} 长度不合法`);
  if (pattern && !pattern.test(v)) throw new ArgError(`${field} 格式不合法`);
  return v;
}

export function n(value, { field, min = -Infinity, max = Infinity } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) throw new ArgError(`${field} 数值不合法`);
  return num;
}

export function arr(value, { field, max = 50 } = {}) {
  if (!Array.isArray(value)) throw new ArgError(`${field} 必须是数组`);
  if (value.length > max) throw new ArgError(`${field} 元素过多`);
  return value;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new ArgError(`${field} 取值必须是 ${allowed.join('/')}`);
  return value;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') throw new ArgError(`${field} 必须是布尔值`);
  return value;
}

export function obj(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArgError(`${field} 必须是对象`);
  }
  return value;
}

/** 仅允许固定前缀下的绝对路径，禁止 .. 与空字节 */
export function absPath(value, prefixes, field) {
  const v = s(value, { field, max: 512 });
  if (!v.startsWith('/') || v.includes('..') || v.includes('\0')) {
    throw new ArgError(`${field} 不是合法绝对路径`);
  }
  if (prefixes && !prefixes.some((p) => v === p || v.startsWith(`${p}/`))) {
    throw new ArgError(`${field} 必须位于 ${prefixes.join(' 或 ')} 之下`);
  }
  return v;
}

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
