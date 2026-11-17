#!/usr/bin/env node
/**
 * 数据库迁移状态 / 手动执行迁移。
 *
 *   npm run migrate            # 执行未应用的迁移并打印结果
 *   npm run migrate -- --status  # 只查看已应用版本
 */

import process from 'node:process';
import { openDatabase } from '../panel/src/db/index.js';
import { config } from '../panel/src/config.js';

const { db, get, all, close } = openDatabase({ verbose: true });

const applied = all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
console.log(`数据库：${config.dbPath}`);
console.log(`已应用迁移：${applied.length} 个`);
for (const row of applied) {
  console.log(`  ${String(row.version).padStart(3, '0')}  ${row.name}  (${row.applied_at})`);
}

if (!process.argv.includes('--status')) {
  const sites = Number(get('SELECT COUNT(*) c FROM sites').c);
  const tasks = Number(get('SELECT COUNT(*) c FROM tasks').c);
  console.log(`当前数据：站点 ${sites} 个，任务 ${tasks} 条`);
}
close();
