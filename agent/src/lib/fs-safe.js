/**
 * 文件系统安全操作：所有路径在写入/删除前都做前缀校验 + realpath 复核。
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCapture } from './exec.js';

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.code = 'PATH_DENIED';
  }
}

/** 目标必须位于 base 之下（含 base 本身） */
export function assertWithin(base, target) {
  const baseAbs = path.resolve(base);
  const targetAbs = path.resolve(target);
  if (targetAbs !== baseAbs && !targetAbs.startsWith(`${baseAbs}${path.sep}`)) {
    throw new PathError(`路径越界：${targetAbs} 不在 ${baseAbs} 之内`);
  }
  return targetAbs;
}

/** 校验父目录 realpath 后仍在前缀内（防符号链接逃逸） */
export function assertRealWithin(base, target) {
  const abs = assertWithin(base, target);
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  assertWithin(fs.existsSync(base) ? fs.realpathSync(base) : path.resolve(base), real);
  return abs;
}

export async function resolveUid(user) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new PathError('非法用户名');
  const res = await runCapture('id', ['-u', user]);
  if (!res.ok) return null;
  const uid = Number(res.stdout);
  return Number.isFinite(uid) ? uid : null;
}

export async function resolveGid(group) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(group)) throw new PathError('非法组名');
  const res = await runCapture('getent', ['group', group]);
  if (!res.ok) return null;
  const gid = Number(res.stdout.split(':')[2]);
  return Number.isFinite(gid) ? gid : null;
}

export async function ensureDir(dir, { mode = 0o755, uid = null, gid = null } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* ignore */ }
  if (uid !== null) {
    try { fs.chownSync(dir, uid, gid ?? uid); } catch { /* ignore */ }
  }
  return dir;
}

/** 原子写：先写临时文件再 rename，避免 nginx 读到半个文件 */
export function writeAtomic(file, content, { mode = 0o644, uid = null, gid = null } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* ignore */ }
  if (uid !== null) {
    try { fs.chownSync(tmp, uid, gid ?? uid); } catch { /* ignore */ }
  }
  fs.renameSync(tmp, file);
  return file;
}

export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function ensureSymlink(target, link) {
  try {
    const cur = fs.readlinkSync(link);
    if (cur === target) return 'unchanged';
    fs.unlinkSync(link);
  } catch { /* 不存在则创建 */ }
  fs.symlinkSync(target, link);
  return 'created';
}

/** 读取文件末尾 N 行（最大 1MB，避免大日志拖垮内存） */
export function readTail(file, lines = 200, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
  } finally {
    fs.closeSync(fd);
  }
}

/** 目录占用（MB）与文件数，文件数最多统计 50000 个，避免大站点卡住 */
export function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d, depth) => {
    if (files > 50000 || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        const st = fs.lstatSync(p);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p, depth + 1);
        else {
          bytes += st.size;
          files += 1;
        }
      } catch { /* ignore */ }
    }
  };
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) throw new Error('not a directory');
    walk(dir, 0);
  } catch {
    return { diskMb: 0, files: 0 };
  }
  return { diskMb: Math.round(bytes / 1048576), files };
}
