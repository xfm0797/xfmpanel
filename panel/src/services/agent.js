/**
 * agent 客户端（生产：unix socket；开发：stub）。
 *
 * 通信格式：一行 JSON 请求 + 多行 JSON 帧响应。
 * 请求体用 HMAC-SHA256 签名，agent 侧验签后再执行，防止本机其他用户伪造请求。
 */

import net from 'node:net';
import fs from 'node:fs';
import readline from 'node:readline';
import { config } from '../config.js';
import { hmacSha256, uuid } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FRAME, PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { stubCall } from './agent-stub.js';

const log = createLogger('agent');

let cachedSecret = null;

export function loadSecret() {
  if (config.agentSecret) return config.agentSecret;
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = fs.readFileSync(config.agentSecretFile, 'utf8').trim();
    return cachedSecret;
  } catch {
    return null;
  }
}

function sign(secret, { id, op, ts, nonce, args }) {
  return hmacSha256(secret, [id, op, ts, nonce, JSON.stringify(args ?? {})].join('.'));
}

/**
 * 调用 agent 操作。
 * @param {string} op
 * @param {object} args
 * @param {{onLog?:Function, onProgress?:Function, timeoutMs?:number, signal?:AbortSignal}} hooks
 */
export async function callAgent(op, args = {}, hooks = {}) {
  const { onLog, onProgress, timeoutMs = config.agentTimeoutMs, signal } = hooks;

  if (config.agentMode === 'stub') {
    return stubCall(op, args, hooks);
  }

  const secret = loadSecret();
  if (!secret) {
    throw new HttpError('AGENT_UNAVAILABLE', {
      message: '未找到 agent 通信密钥，请检查 /etc/xfmpanel/agent.secret',
    });
  }

  const id = uuid();
  const ts = Date.now();
  const nonce = uuid();
  const payload = JSON.stringify({
    v: PROTOCOL_VERSION,
    id,
    op,
    args,
    ts,
    nonce,
    sig: sign(secret, { id, op, ts, nonce, args }),
  });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.agentSocket);
    let settled = false;
    let result;
    let rejectedError = null;

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      finish(new HttpError('AGENT_UNAVAILABLE', { message: `agent 响应超时（${op}）` }));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${payload}\n`));
    socket.on('error', (err) => {
      log.error(`agent 连接失败 ${op}`, { message: err.message, socket: config.agentSocket });
      finish(new HttpError('AGENT_UNAVAILABLE', {
        message: '无法连接系统代理服务（xfmpanel-agent），请检查服务状态',
      }));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        finish(new HttpError('TASK_CONFLICT', { message: '任务已取消' }));
      }, { once: true });
    }

    const rl = readline.createInterface({ input: socket });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log.warn('agent 返回了非 JSON 帧', { line: line.slice(0, 200) });
        return;
      }
      switch (frame.type) {
        case FRAME.READY:
          break;
        case FRAME.LOG:
          onLog?.(frame.level || 'info', String(frame.message ?? ''));
          break;
        case FRAME.PROGRESS:
          onProgress?.(Number(frame.progress) || 0, frame.message);
          break;
        case FRAME.RESULT:
          result = frame.data;
          finish(null, result);
          break;
        case FRAME.ERROR:
          rejectedError = new HttpError('AGENT_REJECTED', {
            message: frame.message || 'agent 执行失败',
            details: frame.code ? { agentCode: frame.code } : undefined,
          });
          finish(rejectedError);
          break;
        default:
          log.debug('未知帧类型', { type: frame.type });
      }
    });

    rl.on('close', () => {
      if (settled) return;
      finish(new HttpError('AGENT_UNAVAILABLE', {
        message: 'agent 连接提前关闭，操作结果未知，请到任务日志确认',
      }));
    });
  });
}

/** 健康检查：短超时，不抛异常 */
export async function agentHealth() {
  try {
    const started = Date.now();
    await callAgent('system.ping', {}, { timeoutMs: 3000 });
    return { ok: true, latencyMs: Date.now() - started, mode: config.agentMode };
  } catch (err) {
    return { ok: false, error: err.message, mode: config.agentMode };
  }
}
