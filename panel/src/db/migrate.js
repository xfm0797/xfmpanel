/**
 * 极简迁移执行器。
 *
 * 约定：panel/src/db/migrations/NNN_name.sql 按文件名升序执行，
 * 已执行版本记录在 schema_migrations，重复启动不会重放。
 * 每个迁移文件在单个事务内执行，失败整体回滚。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function migrate(db, { log = () => {} } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (!Number.isFinite(version)) continue;
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(version, file, new Date().toISOString());
      db.exec('COMMIT');
      count += 1;
      log(`已应用迁移 ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${file} 执行失败: ${err.message}`);
    }
  }
  return count;
}
