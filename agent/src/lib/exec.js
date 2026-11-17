/**
 * 命令执行器：只接受 argv 数组，永不经过 shell。
 *
 * 所有系统命令都在 agent 内部以固定参数形式调用，面板无法注入任意命令。
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

export class ExecError extends Error {
  constructor(cmd, args, code, stderr, stdout) {
    super(`${cmd} 执行失败（exit=${code}）：${(stderr || stdout || '').trim().slice(-800)}`);
    this.name = 'ExecError';
    this.code = 'EXEC_FAILED';
    this.exitCode = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.cmd = cmd;
    this.args = args;
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeout?:number, onLine?:(line:string, stream:'stdout'|'stderr')=>void, env?:object, cwd?:string, allowFailure?:boolean}} opts
 */
export function run(cmd, args = [], opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT, onLine, env, cwd, allowFailure = false, input,
  } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}), DEBIAN_FRONTEND: 'noninteractive' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeout);
    }

    const wire = (stream, tag) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (tag === 'stdout') stdout += chunk; else stderr += chunk;
        if (!onLine) return;
        buf += chunk;
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).trimEnd();
          buf = buf.slice(idx + 1);
          if (line) onLine(line, tag);
          idx = buf.indexOf('\n');
        }
      });
    };

    wire(child.stdout, 'stdout');
    wire(child.stderr, 'stderr');

    if (input) child.stdin.end(input);
    else child.stdin.end();

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new ExecError(cmd, args, -1, err.message, ''));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new ExecError(cmd, args, code, stderr, stdout));
      }
    });
  });
}

export async function runCapture(cmd, args = [], opts = {}) {
  const res = await run(cmd, args, { ...opts, allowFailure: true });
  return {
    code: res.code,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    ok: res.code === 0,
  };
}

/** 命令是否存在（遍历 PATH，不经过 shell） */
export async function exists(bin) {
  const paths = (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(':');
  for (const p of paths) {
    try {
      const { accessSync, constants } = await import('node:fs');
      accessSync(`${p}/${bin}`, constants.X_OK);
      return `${p}/${bin}`;
    } catch { /* continue */ }
  }
  return null;
}
