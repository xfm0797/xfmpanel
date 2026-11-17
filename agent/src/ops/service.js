/**
 * systemd 服务状态与控制。单元名走白名单，杜绝任意 unit 操作。
 */

import { run, runCapture } from '../lib/exec.js';
import { s, oneOf } from './args.js';

const UNIT_RE = /^(nginx|mariadb|mysql|redis-server|php\d\.\d-fpm)$/;

function assertUnit(unit) {
  const v = s(unit, { field: 'unit', max: 40 });
  if (!UNIT_RE.test(v)) throw Object.assign(new Error(`不允许操作的服务单元：${v}`), { code: 'BAD_UNIT' });
  return v;
}

export const serviceOps = {
  'service.status': {
    validate: (args) => ({ unit: assertUnit(args.unit) }),
    run: async ({ unit }) => {
      const active = await runCapture('systemctl', ['is-active', unit], { timeout: 5000 });
      const enabled = await runCapture('systemctl', ['is-enabled', unit], { timeout: 5000 });
      const show = await runCapture('systemctl', ['show', unit, '-p', 'ActiveEnterTimestamp', '-p', 'SubState', '-p', 'MainPID'], { timeout: 5000 });
      const props = {};
      for (const line of show.stdout.split('\n')) {
        const [k, v] = line.split('=');
        if (k) props[k] = v;
      }
      return {
        unit,
        active: active.stdout === 'active',
        state: active.stdout || 'unknown',
        enabled: enabled.stdout === 'enabled',
        since: props.ActiveEnterTimestamp || null,
        subState: props.SubState || null,
        mainPid: props.MainPID ? Number(props.MainPID) : null,
      };
    },
  },

  'service.action': {
    validate: (args) => ({
      unit: assertUnit(args.unit),
      action: oneOf(args.action, ['start', 'stop', 'restart', 'reload'], 'action'),
    }),
    run: async ({ unit, action }, emit) => {
      emit.log('info', `systemctl ${action} ${unit}`);
      const res = await run('systemctl', [action, unit], {
        timeout: 60_000,
        onLine: (line, stream) => {
          if (stream === 'stderr' && line.trim()) emit.log('warn', line.trim());
        },
      });
      const status = await runCapture('systemctl', ['is-active', unit], { timeout: 5000 });
      emit.log('info', `${unit} 当前状态：${status.stdout || 'unknown'}`);
      return { unit, action, active: status.stdout === 'active', output: res.stdout.slice(-2000) };
    },
  },

  'nginx.test': {
    validate: () => ({}),
    run: async (_, emit) => {
      const res = await runCapture('nginx', ['-t'], { timeout: 20_000 });
      const detail = `${res.stdout}\n${res.stderr}`.trim();
      if (!res.ok) {
        const err = new Error(`nginx 配置测试失败：${res.stderr || res.stdout}`);
        err.code = 'NGINX_TEST_FAILED';
        throw err;
      }
      emit.log('info', detail || 'nginx -t 通过');
      return { ok: true, output: detail };
    },
  },

  'nginx.reload': {
    validate: () => ({}),
    run: async (_, emit) => {
      await runCapture('nginx', ['-t'], { timeout: 20_000 }).then((r) => {
        if (!r.ok) {
          const err = new Error(`nginx 配置测试失败，已阻止重载：${r.stderr}`);
          err.code = 'NGINX_TEST_FAILED';
          throw err;
        }
      });
      await run('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
      emit.log('info', 'nginx 已平滑重载');
      return { ok: true };
    },
  },
};
