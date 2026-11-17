/**
 * 日志接口：面板运行日志 + 审计日志。
 * 站点访问/错误日志在 /sites/:id/logs（走 agent，只能读受控目录）。
 */

import { perm } from '../http/security.js';
import { tailFile, logFile } from '../lib/logger.js';
import { listAuditLogs } from '../services/users.js';
import fs from 'node:fs';

export function registerLogRoutes(app) {
  app.get('/api/v1/logs/panel', perm('log:read'), async (ctx) => {
    const lines = Math.min(Math.max(Number(ctx.query.lines) || 300, 20), 2000);
    const level = ctx.query.level;
    let items = tailFile(logFile(), 2000);
    if (level) {
      items = items.filter((l) => l.includes(`"level":"${level}"`));
    }
    return { file: logFile(), total: items.length, lines: items.slice(-lines) };
  });

  app.get('/api/v1/logs/audit', perm('log:read'), async (ctx) => listAuditLogs(ctx.query));

  app.get('/api/v1/logs/files', perm('log:read'), async () => {
    const dir = logFile().replace(/[\\/][^\\/]+$/, '');
    if (!fs.existsSync(dir)) return { files: [] };
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('panel.log'))
      .map((f) => {
        const st = fs.statSync(`${dir}/${f}`);
        return { name: f, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      });
    return { files };
  });
}
