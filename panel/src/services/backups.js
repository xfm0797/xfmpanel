/**
 * 备份保留策略：按 ops.backupRetentionDays 清理 agent 磁盘文件与 backups 记录。
 */

import { getDb } from '../db/index.js';
import { getSetting } from '../db/seed.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { callAgent } from './agent.js';

const log = createLogger('backups');

export async function cleanupOldBackups() {
  const configured = Number(getSetting('ops.backupRetentionDays', config.backupRetentionDays));
  const keepDays = Number.isFinite(configured) && configured > 0 ? configured : config.backupRetentionDays;

  const res = await callAgent('site.backup.prune', { keepDays }, { timeoutMs: 60_000 });
  const deleted = Array.isArray(res?.deleted) ? res.deleted : [];
  if (!deleted.length) return { deleted: 0, freedBytes: 0 };

  const db = getDb();
  for (const file of deleted) db.run('DELETE FROM backups WHERE path = ?', [file]);

  const freedBytes = Number(res.freedBytes) || 0;
  log.info(`清理过期备份 ${deleted.length} 个，释放 ${(freedBytes / 1048576).toFixed(1)}MB`);
  return { deleted: deleted.length, freedBytes };
}
