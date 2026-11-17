/**
 * 密码 / 令牌 / 签名工具。全部基于 node:crypto，无三方依赖。
 */

import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** 生成 `scrypt$N$r$p$salt$hash` 格式的密码散列 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** 恒定时间比较，避免计时侧信道 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function uuid() {
  return crypto.randomUUID();
}

/** 密码强度：至少 10 位，包含字母与数字 */
export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return { ok: false, message: '密码至少 10 位' };
  }
  if (password.length > 128) return { ok: false, message: '密码过长' };
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, message: '密码需同时包含字母与数字' };
  }
  const weak = ['1234567890', 'password', 'admin12345', 'qwertyuiop'];
  if (weak.some((w) => password.toLowerCase().includes(w))) {
    return { ok: false, message: '密码过于常见，请更换' };
  }
  return { ok: true };
}
