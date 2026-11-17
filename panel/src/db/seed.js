/**
 * 首次启动初始化：默认设置 + 超管账号。
 *
 * 超管密码来源优先级：
 *   1) XFMP_ADMIN_PASSWORD 环境变量（推荐在安装脚本里生成随机密码）
 *   2) 随机生成，写入 <dataDir>/initial-admin.txt（0600），并在控制台提示
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb, nowIso } from './index.js';
import { config } from '../config.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('seed');

const DEFAULT_SETTINGS = {
  'panel.name': 'XFMPanel',
  'panel.publicUrl': '',
  'site.defaultAppType': 'php',
  'site.defaultPhpVersion': '8.3',
  'site.defaultRewrite': 'none',
  'cert.email': '',
  'cert.autoRenew': 'true',
  'cert.renewBeforeDays': '30',
  'security.sessionTtlHours': '12',
  'security.loginMaxAttempts': '5',
  'ops.taskRetentionDays': '30',
  'ops.backupBeforeDelete': 'true',
  'notify.webhookUrl': '',
};

export function seedDatabase() {
  const db = getDb();
  const now = nowIso();

  const insertSetting = db.db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(k, v, now);
  }

  const count = Number(db.get('SELECT COUNT(*) c FROM users').c);
  if (count > 0) return { created: false };

  const username = process.env.XFMP_ADMIN_USER || 'admin';
  let password = config.bootstrapAdminPassword;
  let generated = false;
  if (!password) {
    password = `${randomToken(9)}Aa1!`;
    generated = true;
  }

  db.run(
    `INSERT INTO users (username, display_name, password_hash, role, status, password_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`,
    [username, '超级管理员', hashPassword(password), now, now, now],
  );

  if (generated) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, 'initial-admin.txt');
    fs.writeFileSync(
      file,
      `XFMPanel 初始账号\n用户名: ${username}\n密码: ${password}\n生成时间: ${now}\n首次登录后请立即修改密码，并删除本文件。\n`,
      { mode: 0o600 },
    );
    log.warn(`已生成初始管理员账号，密码见 ${file}`);
  }

  log.info(`初始化完成，管理员账号：${username}`);
  return { created: true, username, generated };
}

export function getSetting(key, fallback = null) {
  const row = getDb().get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

export function getSettings(prefix = '') {
  const rows = getDb().all(
    prefix ? 'SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key' : 'SELECT key, value FROM settings ORDER BY key',
    prefix ? [`${prefix}%`] : [],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key, value, userId = null) {
  getDb().run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, String(value), nowIso(), userId],
  );
}
