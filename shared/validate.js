/**
 * 共享校验工具。
 *
 * 注意：面板侧校验只是为了给出友好的错误提示；agent 侧会独立再校验一次，
 * 因为 panel 进程被攻破时不能信任它传来的任何字段（纵深防御）。
 */

import { PATHS } from './paths.js';

export class ValidationError extends Error {
  constructor(message, field, details) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_FAILED';
    this.field = field;
    this.details = details;
  }
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
// 允许 punycode(xn--)、字母数字与连字符；标签长度 1-63
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9\u4e00-\u9fa5-]{1,63}(?<!-)(\.(?!-)[a-z0-9\u4e00-\u9fa5-]{1,63}(?<!-))+$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export function ok(value) {
  return { ok: true, value };
}

export function fail(message, field) {
  return { ok: false, error: new ValidationError(message, field) };
}

export function assertSlug(value, field = 'slug') {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new ValidationError('标识只能包含小写字母、数字和中划线，以字母开头、字母或数字结尾，长度 3-32', field);
  }
  return value;
}

export function assertDomain(value, field = 'domain') {
  if (typeof value !== 'string') throw new ValidationError('域名格式不正确', field);
  const v = value.trim().toLowerCase();
  if (v.length > 253) throw new ValidationError('域名过长', field);
  if (IPV4_RE.test(v)) {
    const parts = v.split('.').map(Number);
    if (parts.some((p) => p > 255)) throw new ValidationError('IP 地址不合法', field);
    return v;
  }
  if (!DOMAIN_RE.test(v)) throw new ValidationError('域名格式不正确，例如 example.com', field);
  if (!v.includes('.')) throw new ValidationError('请填写完整域名，例如 example.com', field);
  return v;
}

export function assertDomains(list, field = 'domains') {
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError('至少需要一个域名', field);
  }
  if (list.length > 20) throw new ValidationError('域名数量不能超过 20 个', field);
  const out = [];
  for (const item of list) {
    const d = assertDomain(item, field);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** 站点根路径必须落在 /www/xfm 之下，且不含 .. */
export function assertSitePath(value, field = 'rootPath') {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new ValidationError('路径必须是绝对路径', field);
  }
  if (value.includes('..') || value.includes('\0')) {
    throw new ValidationError('路径包含非法字符', field);
  }
  if (!value.startsWith(`${PATHS.WWW_ROOT}/`)) {
    throw new ValidationError(`站点目录必须位于 ${PATHS.WWW_ROOT}/ 之下`, field);
  }
  return value.replace(/\/+$/, '');
}

export function assertPort(value, field = 'port') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ValidationError('端口必须是 1-65535 的整数', field);
  }
  return n;
}

export function assertInt(value, { field = 'value', min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError('缺失必填数值', field);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`数值必须是 ${min}-${max} 之间的整数`, field);
  }
  return n;
}

export function assertEnum(value, allowed, field = 'value') {
  if (!allowed.includes(value)) {
    throw new ValidationError(`取值必须是 ${allowed.join(' / ')} 之一`, field);
  }
  return value;
}

export function assertString(value, { field = 'value', min = 0, max = 255, pattern, trim = true } = {}) {
  if (typeof value !== 'string') throw new ValidationError('必须是字符串', field);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw new ValidationError(`长度不能少于 ${min}`, field);
  if (v.length > max) throw new ValidationError(`长度不能超过 ${max}`, field);
  if (pattern && !pattern.test(v)) throw new ValidationError('格式不正确', field);
  return v;
}

/** PHP 版本号，如 8.3 / 8.2 / 7.4 */
export function assertPhpVersion(value, field = 'phpVersion') {
  if (typeof value !== 'string' || !/^\d\.\d{1,2}$/.test(value)) {
    throw new ValidationError('PHP 版本格式应为 8.3 这样的形式', field);
  }
  return value;
}

/** 用于 /etc/nginx 与 php-fpm 配置的注释安全化：只允许安全字符 */
export function safeComment(value, max = 200) {
  return String(value ?? '')
    .replace(/[^\w\u4e00-\u9fa5 .:@/_-]/g, '')
    .slice(0, max);
}

export function isPrivateIp(ip) {
  if (!IPV4_RE.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function normalizeIp(input) {
  if (!input) return '';
  let ip = String(input).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip.replace(/:\d+$/, '');
}
