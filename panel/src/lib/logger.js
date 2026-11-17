/**
 * 面板日志：JSON Lines 落盘 + 控制台，按大小滚动（5MB × 5）。
 * 生产环境交给 journald 收集，文件日志主要方便“日志”页直接查看。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 5;

let stream = null;
let currentBytes = 0;
let filePath = '';

function openStream() {
  fs.mkdirSync(config.logDir, { recursive: true });
  filePath = path.join(config.logDir, 'panel.log');
  try {
    currentBytes = fs.statSync(filePath).size;
  } catch {
    currentBytes = 0;
  }
  stream = fs.createWriteStream(filePath, { flags: 'a' });
  stream.on('error', () => { stream = null; });
}

function rotate() {
  try {
    stream?.end();
    for (let i = KEEP - 1; i >= 1; i -= 1) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* 滚动失败不影响主流程 */
  }
  openStream();
}

function write(level, module, message, extra) {
  const min = LEVELS[String(process.env.XFMP_LOG_LEVEL || 'info').toLowerCase()] ?? 20;
  if (LEVELS[level] < min) return;

  const entry = {
    t: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...(extra && Object.keys(extra).length ? { ctx: extra } : {}),
  };
  const line = `${JSON.stringify(entry)}\n`;

  if (!stream) openStream();
  if (currentBytes + line.length > MAX_BYTES) rotate();

  stream?.write(line);
  currentBytes += line.length;

  if (config.isDev || LEVELS[level] >= LEVELS.warn) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${entry.t}] ${level.toUpperCase()} ${module} - ${message}`,
      extra && Object.keys(extra).length ? extra : '');
  }
}

export function createLogger(module) {
  return {
    debug: (m, x) => write('debug', module, m, x),
    info: (m, x) => write('info', module, m, x),
    warn: (m, x) => write('warn', module, m, x),
    error: (m, x) => write('error', module, m, x),
  };
}

export const logFile = () => filePath || path.join(config.logDir, 'panel.log');

export function tailFile(file, lines = 200) {
  if (!fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, 512 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    return buf
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-lines);
  } finally {
    fs.closeSync(fd);
  }
}
