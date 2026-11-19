/**
 * 网站环境安装 / 卸载（Debian / Ubuntu 为主，RHEL 系给出明确不支持提示）。
 *
 * 所有安装动作都是幂等的：已安装的包再次执行不会破坏现有环境。
 */

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { run, runCapture } from '../lib/exec.js';
import {
  detectDistro, aptInstall, aptRemove, aptUpdate, ensurePhpRepo,
} from '../lib/distro.js';
import { ensureDir, writeAtomic } from '../lib/fs-safe.js';
import { s, oneOf } from './args.js';

const KINDS = ['nginx', 'php', 'mariadb', 'redis', 'nodejs'];

function assertRoot() {
  if (process.getuid?.() !== 0) {
    const err = new Error('agent 需要 root 权限才能安装软件');
    err.code = 'NOT_ROOT';
    throw err;
  }
}

function phpPackages(version) {
  const exts = ['fpm', 'cli', 'mysql', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'bcmath', 'opcache', 'intl', 'readline', 'sqlite3'];
  return exts.map((e) => `php${version}-${e}`);
}

function writeNginxBase(emit) {
  const conf = `# 由 XFMPanel 管理 —— 全局安全与性能基线
server_tokens off;
client_max_body_size 64m;
client_body_timeout 60s;
keepalive_timeout 65s;
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript application/xml image/svg+xml;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
`;
  ensureDir('/etc/nginx/conf.d', { mode: 0o755 });
  writeAtomic('/etc/nginx/conf.d/00-xfmpanel.conf', conf, { mode: 0o644 });
  emit.log('info', '已写入 nginx 全局基线配置 /etc/nginx/conf.d/00-xfmpanel.conf');
}

function memTotalMb() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    return Math.round(Number((/MemTotal:\s+(\d+)/.exec(raw) || [])[1] || 0) / 1024);
  } catch {
    return 1024;
  }
}

async function verifyService(unit, emit, { required = true } = {}) {
  const res = await runCapture('systemctl', ['is-active', unit], { timeout: 8000 });
  const active = res.stdout.trim() === 'active';
  emit.log(active ? 'info' : 'warn', `${unit} 状态：${res.stdout.trim() || 'unknown'}`);
  if (!active && required) {
    const err = new Error(`${unit} 未能启动，请查看 journalctl -u ${unit} -n 100`);
    err.code = 'SERVICE_NOT_RUNNING';
    throw err;
  }
  return active;
}

export const runtimeOps = {
  'runtime.install': {
    validate: (args) => ({
      kind: oneOf(args.kind, KINDS, 'kind'),
      version: s(args.version, { field: 'version', max: 10, pattern: /^\d{1,2}(\.\d{1,2})?$/ }),
    }),

    run: async ({ kind, version }, emit) => {
      assertRoot();
      const distro = await detectDistro();
      emit.log('info', `系统：${distro.id} ${distro.versionId}（${distro.family}）`);
      if (distro.pkg !== 'apt') {
        const err = new Error(`暂不支持 ${distro.id} 的自动安装，请使用 Debian 12 / Ubuntu 22.04+`);
        err.code = 'UNSUPPORTED_DISTRO';
        throw err;
      }

      emit.progress(5, '更新软件源索引');
      await aptUpdate(emit);

      let result;

      if (kind === 'nginx') {
        emit.progress(25, '安装 Nginx');
        await aptInstall(['nginx'], emit);
        writeNginxBase(emit);
        await run('systemctl', ['enable', '--now', 'nginx'], { timeout: 60_000 });
        const test = await runCapture('nginx', ['-t'], { timeout: 20_000 });
        if (!test.ok) {
          const err = new Error(`nginx 配置校验失败：${test.stderr}`);
          err.code = 'NGINX_TEST_FAILED';
          throw err;
        }
        emit.progress(90, '校验服务状态');
        await verifyService('nginx', emit);
        const ver = await runCapture('nginx', ['-v'], { timeout: 5000 });
        result = {
          serviceName: 'nginx',
          configPath: '/etc/nginx/nginx.conf',
          installPath: '/usr/sbin/nginx',
          resolvedVersion: (/nginx\/([\d.]+)/.exec(ver.stderr + ver.stdout) || [])[1] || version,
        };
      } else if (kind === 'php') {
        emit.progress(15, '检查 PHP 软件源');
        await ensurePhpRepo(version, distro, emit);
        emit.progress(35, `安装 PHP ${version} 及常用扩展`);
        await aptInstall(phpPackages(version), emit);

        const tinyHost = os.totalmem() <= 1280 * 1024 * 1024; // 1C512M / 1G 小内存机型
        const iniPath = `/etc/php/${version}/fpm/conf.d/99-xfmpanel.ini`;
        ensureDir(path.dirname(iniPath), { mode: 0o755 });
        writeAtomic(iniPath, [
          '; 由 XFMPanel 写入：安全与稳定性基线',
          'expose_php = Off',
          'cgi.fix_pathinfo = 0',
          'display_errors = Off',
          'log_errors = On',
          `memory_limit = ${tinyHost ? 128 : 256}M`,
          'upload_max_filesize = 64M',
          'post_max_size = 64M',
          'max_execution_time = 120',
          'date.timezone = Asia/Shanghai',
          'opcache.enable = 1',
          `opcache.memory_consumption = ${tinyHost ? 64 : 128}`,
          `opcache.max_accelerated_files = ${tinyHost ? 5000 : 10000}`,
          'opcache.validate_timestamps = 1',
          'opcache.revalidate_freq = 60',
          '',
        ].join('\n'), { mode: 0o644 });
        emit.log('info', `已写入 PHP 基线配置 ${iniPath}`);

        ensureDir('/run/php', { mode: 0o755 });
        await run('chown', ['www-data:www-data', '/run/php'], { timeout: 10_000, allowFailure: true });
        ensureDir(`/etc/php/${version}/fpm/pool.d`, { mode: 0o755 });

        emit.progress(85, '启动 PHP-FPM');
        await run('systemctl', ['enable', '--now', `php${version}-fpm`], { timeout: 90_000 });
        await verifyService(`php${version}-fpm`, emit);
        const ver = await runCapture(`php${version}`, ['-v'], { timeout: 5000 });
        result = {
          serviceName: `php${version}-fpm`,
          configPath: `/etc/php/${version}/fpm/php-fpm.conf`,
          installPath: `/etc/php/${version}`,
          resolvedVersion: (/(\d+\.\d+\.\d+)/.exec(ver.stdout) || [])[1] || version,
        };
      } else if (kind === 'mariadb') {
        emit.progress(25, '安装 MariaDB');
        await aptInstall(['mariadb-server', 'mariadb-client'], emit);

        const mem = memTotalMb();
        const bufferPool = Math.max(128, Math.min(2048, Math.round(mem * 0.25)));
        writeAtomic('/etc/mysql/mariadb.conf.d/60-xfmpanel.cnf', [
          '# 由 XFMPanel 写入',
          '[mysqld]',
          'bind-address = 127.0.0.1',
          'skip-name-resolve',
          `innodb_buffer_pool_size = ${bufferPool}M`,
          'innodb_flush_log_at_trx_commit = 2',
          'max_connections = 200',
          'character-set-server = utf8mb4',
          'collation-server = utf8mb4_unicode_ci',
          '',
          '[client]',
          'default-character-set = utf8mb4',
          '',
        ].join('\n'), { mode: 0o644 });
        emit.log('info', `已按内存 ${mem}MB 调整 InnoDB buffer pool 为 ${bufferPool}MB`);

        emit.progress(85, '启动 MariaDB');
        await run('systemctl', ['enable', '--now', 'mariadb'], { timeout: 120_000 });
        await verifyService('mariadb', emit);
        const ver = await runCapture('mariadb', ['--version'], { timeout: 8000 });
        result = {
          serviceName: 'mariadb',
          configPath: '/etc/mysql/mariadb.conf.d/60-xfmpanel.cnf',
          installPath: '/var/lib/mysql',
          resolvedVersion: (/(\d+\.\d+\.\d+)/.exec(ver.stdout) || [])[1] || version,
        };
      } else if (kind === 'redis') {
        emit.progress(25, '安装 Redis');
        await aptInstall(['redis-server'], emit);
        const password = crypto.randomBytes(18).toString('base64url');
        writeAtomic('/etc/redis/xfmpanel.conf', [
          '# 由 XFMPanel 写入（覆盖默认配置）',
          'bind 127.0.0.1 -::1',
          'protected-mode yes',
          'port 6379',
          `requirepass ${password}`,
          'maxmemory-policy allkeys-lru',
          'save 900 1',
          'save 300 10',
          'appendonly no',
          '',
        ].join('\n'), { mode: 0o640 });

        const mainConf = '/etc/redis/redis.conf';
        if (fs.existsSync(mainConf)) {
          const content = fs.readFileSync(mainConf, 'utf8');
          if (!content.includes('xfmpanel.conf')) {
            fs.writeFileSync(mainConf, `include /etc/redis/xfmpanel.conf\n${content}`);
          }
        }
        emit.progress(85, '重启 Redis');
        await run('systemctl', ['enable', 'redis-server'], { timeout: 30_000 });
        await run('systemctl', ['restart', 'redis-server'], { timeout: 60_000 });
        await verifyService('redis-server', emit);
        emit.log('info', 'Redis 已设置随机密码，可在「网站环境 → 详情」查看');
        result = {
          serviceName: 'redis-server',
          configPath: '/etc/redis/xfmpanel.conf',
          installPath: '/var/lib/redis',
          resolvedVersion: version,
          credentials: { password },
        };
      } else {
        emit.progress(25, '安装 Node.js');
        await aptInstall(['nodejs', 'npm'], emit);
        const ver = await runCapture('node', ['-v'], { timeout: 5000 });
        const major = (ver.stdout || '').replace('v', '').split('.')[0];
        if (major !== String(version)) {
          emit.log('warn', `发行版自带 Node ${ver.stdout}，与请求的 ${version} 不一致；如需精确版本请使用 NodeSource 或 nvm`);
        }
        result = {
          serviceName: null,
          configPath: null,
          installPath: '/usr/bin/node',
          resolvedVersion: ver.stdout || version,
        };
      }

      emit.progress(100, '安装完成');
      return { kind, version, ...result };
    },
  },

  'runtime.remove': {
    validate: (args) => ({
      kind: oneOf(args.kind, KINDS, 'kind'),
      version: s(args.version, { field: 'version', max: 10 }),
      serviceName: args.serviceName ? s(args.serviceName, { field: 'serviceName', max: 40, pattern: /^(nginx|mariadb|redis-server|php\d\.\d-fpm)$/ }) : undefined,
    }),

    run: async ({ kind, version, serviceName }, emit) => {
      assertRoot();
      const unit = serviceName || (kind === 'php' ? `php${version}-fpm` : kind === 'redis' ? 'redis-server' : kind);
      emit.log('info', `停止 ${unit}`);
      await run('systemctl', ['disable', '--now', unit], { timeout: 60_000, allowFailure: true });

      if (kind === 'php') {
        emit.progress(40, `卸载 PHP ${version}`);
        await aptRemove(phpPackages(version), emit);
        emit.log('warn', `站点目录 /etc/php/${version} 中的 pool 配置已随包删除`);
      } else if (kind === 'nginx') {
        await aptRemove(['nginx', 'nginx-common'], emit);
      } else if (kind === 'mariadb') {
        emit.log('warn', 'MariaDB 数据目录 /var/lib/mysql 保留，如需彻底清理请手动删除');
        await aptRemove(['mariadb-server', 'mariadb-client'], emit);
      } else if (kind === 'redis') {
        await aptRemove(['redis-server'], emit);
      } else {
        await aptRemove(['nodejs', 'npm'], emit);
      }

      emit.progress(90, '刷新服务状态');
      emit.log('success', `${kind} ${version} 已卸载`);
      return { removed: true };
    },
  },
};
