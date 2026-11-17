/**
 * 数据库访问层：node:sqlite（同步 API，配合单进程事件循环足够用）。
 *
 * 说明：面板的并发量级是“几十个请求/秒”，同步 SQLite 反而能避免连接池与
 * 事务竞态问题；WAL 模式下读写互不阻塞。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrate } from './migrate.js';

let instance = null;

export function openDatabase({ file = config.dbPath, verbose = false } = {}) {
  if (instance) return instance;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  migrate(db, { log: verbose ? (m) => console.log(m) : () => {} });

  instance = {
    db,
    file,
    close: () => {
      try { db.close(); } catch { /* ignore */ }
      instance = null;
    },
    all: (sql, params = []) => db.prepare(sql).all(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    /** 事务包装：回调抛错自动回滚 */
    tx: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },
  };
  return instance;
}

export function getDb() {
  if (!instance) return openDatabase();
  return instance;
}

export function nowIso() {
  return new Date().toISOString();
}

/** JSON 字段安全解析 */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? {});
}

/** 分页参数整理 */
export function paging(query = {}, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(maxSize, Math.max(1, Number(query.size) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}
