#!/usr/bin/env node
/**
 * 重置管理员密码 / 解锁账号（仅限服务器本地执行，需可访问数据库文件）。
 *
 * 用法：
 *   npm run reset-admin                 # 重置 owner 账号为随机密码
 *   npm run reset-admin -- --user admin --password 'NewPass1234'
 *   npm run reset-admin -- --list       # 列出所有账号
 *
 * 设计：直接操作 SQLite + 复用面板的密码散列逻辑，不依赖 HTTP 服务，
 * 因此面板无法登录时也能救急。
 */

import process from 'node:process';
import { openDatabase } from '../panel/src/db/index.js';
import { hashPassword, randomToken } from '../panel/src/lib/crypto.js';
import { nowIso } from '../panel/src/db/index.js';
import { config } from '../panel/src/config.js';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const { db, close, all, get, run } = openDatabase({ verbose: false });

if (args.includes('--list')) {
  const users = all('SELECT id, username, role, status, last_login_at FROM users ORDER BY id');
  console.log(`数据库：${config.dbPath}`);
  for (const u of users) {
    console.log(`#${u.id}\t${u.username}\t${u.role}\t${u.status}\t${u.last_login_at || '从未登录'}`);
  }
  close();
  process.exit(0);
}

const username = getArg('user') || 'admin';
const password = getArg('password') || `${randomToken(9)}Aa1!`;

const user = get('SELECT * FROM users WHERE username = ?', [username]);
if (user) {
  run(
    `UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL,
       status = 'active', password_changed_at = ?, updated_at = ? WHERE id = ?`,
    [hashPassword(password), nowIso(), nowIso(), user.id],
  );
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), user.id]);
  console.log(`已重置账号 ${username}（#${user.id}）的密码，并踢出所有会话。`);
} else {
  const count = Number(get('SELECT COUNT(*) c FROM users').c);
  if (count > 0) {
    console.error(`账号 ${username} 不存在。使用 --list 查看现有账号，或 --user 指定其它用户名。`);
    close();
    process.exit(1);
  }
  run(
    `INSERT INTO users (username, display_name, password_hash, role, status, password_changed_at, created_at, updated_at)
     VALUES (?, '超级管理员', ?, 'owner', 'active', ?, ?, ?)`,
    [username, hashPassword(password), nowIso(), nowIso(), nowIso()],
  );
  console.log(`已创建超级管理员 ${username}。`);
}

console.log(`用户名：${username}`);
console.log(`新密码：${password}`);
console.log('请登录后立即修改密码。');
close();
