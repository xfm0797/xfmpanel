/**
 * agent 进程：以 root 运行的特权执行器。
 *
 * 信任模型：
 *   - 只监听本机 unix socket（0660 root:xfmpanel），不监听 TCP；
 *   - 每个请求必须带 HMAC-SHA256 签名（密钥 /etc/xfmpanel/agent.secret，0640）；
 *   - 时间戳窗口 ±30s + nonce 防重放；
 *   - 所有操作走白名单 op + 独立参数校验，绝不拼接 shell 字符串；
 *   - 文件写入限定在指定前缀目录，最终 realpath 再校验一次。
 *
 * 即使 panel 进程被攻破，攻击者也只能调用这些受限 op。
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ops } from './ops/index.js';
import { verifyRequest } from './lib/security.js';
import { FRAME, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { PATHS } from '../../shared/paths.js';

const SOCKET_PATH = process.env.XFMP_AGENT_SOCKET || PATHS.AGENT_SOCKET;
const SECRET_FILE = process.env.XFMP_AGENT_SECRET_FILE || PATHS.AGENT_SECRET;
const MAX_CONCURRENCY = Number(process.env.XFMP_AGENT_CONCURRENCY || 4);
const MAX_LINE = 4 * 1024 * 1024;

let secret = '';
let active = 0;

/** 面板进程所属组的 gid：用于 socket 的组权限（root:xfmpanel 0660） */
function panelGid() {
  const fromEnv = Number(process.env.XFMP_PANEL_GID);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const out = execFileSync('getent', ['group', 'xfmpanel'], { encoding: 'utf8' });
    const gid = Number(out.split(':')[2]);
    return Number.isFinite(gid) && gid > 0 ? gid : 0;
  } catch {
    return 0;
  }
}

function log(level, message, extra) {
  const entry = { t: new Date().toISOString(), level, mod: 'agent', msg: message, ...(extra || {}) };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  try {
    fs.appendFileSync(path.join(PATHS.PANEL_LOG_DIR, 'agent.log'), `${line}\n`);
  } catch { /* 日志目录不可写时忽略 */ }
}

function loadSecret() {
  if (process.env.XFMP_AGENT_SECRET) return process.env.XFMP_AGENT_SECRET.trim();
  const value = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  if (value.length < 32) throw new Error('agent 密钥长度不足（至少 32 字符）');
  return value;
}

function ensureSocketDir() {
  const dir = path.dirname(SOCKET_PATH);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o750);
    if (process.getuid?.() === 0) {
      fs.chownSync(dir, 0, panelGid());
    }
  } catch (err) {
    log('warn', `socket 目录权限设置失败: ${err.message}`);
  }
}

function handleConnection(socket) {
  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  let buffer = '';
  let started = false;

  const send = (frame) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  };

  if (active >= MAX_CONCURRENCY) {
    send({ type: FRAME.ERROR, code: 'BUSY', message: 'agent 正忙，请稍后重试' });
    socket.end();
    return;
  }

  socket.on('data', async (chunk) => {
    if (started) return;
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      send({ type: FRAME.ERROR, code: 'TOO_LARGE', message: '请求体过大' });
      socket.end();
      return;
    }
    const idx = buffer.indexOf('\n');
    if (idx < 0) return;
    started = true;
    const line = buffer.slice(0, idx);
    buffer = '';

    let req;
    const check = verifyRequest(line, secret);
    if (!check.ok) {
      log('warn', `拒绝请求：${check.reason}`);
      send({ type: FRAME.ERROR, code: 'UNAUTHORIZED', message: `请求校验失败：${check.reason}` });
      socket.end();
      return;
    }
    req = check.request;

    const op = ops[req.op];
    if (!op) {
      send({ type: FRAME.ERROR, code: 'UNKNOWN_OP', message: `不支持的操作：${req.op}` });
      socket.end();
      return;
    }

    active += 1;
    const t0 = Date.now();
    try {
      const args = op.validate ? op.validate(req.args ?? {}) : req.args ?? {};
      send({ type: FRAME.READY, op: req.op });

      const emitter = {
        log: (level, message) => send({ type: FRAME.LOG, level, message: String(message).slice(0, 2000) }),
        progress: (pct, message) => send({ type: FRAME.PROGRESS, progress: pct, message }),
      };

      const data = await op.run(args, emitter, { socket });
      send({ type: FRAME.RESULT, data: data ?? null });
      log('info', `${req.op} 成功 (${Date.now() - t0}ms)`);
    } catch (err) {
      log('error', `${req.op} 失败: ${err.message}`, { code: err.code });
      send({
        type: FRAME.ERROR,
        code: err.code || 'EXEC_FAILED',
        message: err.message || '执行失败',
      });
    } finally {
      active -= 1;
      socket.end();
    }
  });

  socket.on('error', (err) => {
    log('warn', `socket 错误: ${err.message}`);
  });
}

function main() {
  secret = loadSecret();
  ensureSocketDir();

  if (process.getuid?.() !== 0) {
    log('warn', 'agent 未以 root 运行，涉及系统服务的操作会失败');
  }

  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    log('warn', `旧 socket 清理失败: ${err.message}`);
  }

  const server = net.createServer(handleConnection);
  server.on('error', (err) => {
    log('error', `agent 服务异常: ${err.message}`);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o660);
      if (process.getuid?.() === 0) {
        fs.chownSync(SOCKET_PATH, 0, panelGid());
      }
    } catch (err) {
      log('warn', `socket 权限设置失败: ${err.message}`);
    }
    log('info', `agent 已监听 ${SOCKET_PATH}（协议 v${PROTOCOL_VERSION}）`);
  });

  const shutdown = (sig) => {
    log('info', `收到 ${sig}，关闭 agent`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => log('error', `未捕获异常: ${err.stack || err.message}`));
process.on('unhandledRejection', (r) => log('error', `未处理拒绝: ${r?.message || r}`));

main();
