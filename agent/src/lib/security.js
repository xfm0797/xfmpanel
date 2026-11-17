/**
 * agent 侧请求验签与防重放。
 */

import crypto from 'node:crypto';

const CLOCK_SKEW_MS = 30_000;
const NONCE_TTL_MS = 120_000;

const seenNonces = new Map();

function sweep() {
  const now = Date.now();
  for (const [nonce, at] of seenNonces) {
    if (now - at > NONCE_TTL_MS) seenNonces.delete(nonce);
  }
}

export function verifyRequest(line, secret) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, reason: '非法 JSON' };
  }

  const { id, op, args, ts, nonce, sig } = req || {};
  if (!id || !op || !ts || !nonce || !sig) return { ok: false, reason: '缺少签名字段' };
  if (typeof op !== 'string' || typeof sig !== 'string') return { ok: false, reason: '字段类型错误' };
  if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return { ok: false, reason: '时间戳超出允许范围' };

  sweep();
  if (seenNonces.has(nonce)) return { ok: false, reason: '重放请求' };

  const expected = crypto
    .createHmac('sha256', secret)
    .update([id, op, ts, nonce, JSON.stringify(args ?? {})].join('.'))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: '签名不匹配' };
  }

  seenNonces.set(nonce, Date.now());
  return { ok: true, request: req };
}

export function resetNonces() {
  seenNonces.clear();
}
