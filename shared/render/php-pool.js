/**
 * PHP-FPM pool 渲染器。
 *
 * 每个站点一个独立 pool，独立系统用户，open_basedir 锁定在站点目录，
 * 禁用危险函数 —— 这是 VPS 上多站点共存的最低隔离要求。
 */

import { siteRoot, phpSocketPath, siteLogDir } from '../paths.js';

const BASE_DISABLED_FUNCTIONS = [
  'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen',
  'pcntl_exec', 'putenv', 'dl',
];

export function renderPhpPool(site) {
  const slug = site.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('非法站点标识');

  const version = site.phpVersion;
  if (!/^\d\.\d$/.test(String(version))) throw new Error('非法 PHP 版本');

  const s = site.settings || {};
  const maxChildren = clamp(s.maxChildren ?? 10, 2, 80);
  const startServers = Math.max(2, Math.round(maxChildren / 4));
  const minSpare = Math.max(1, Math.round(maxChildren / 4));
  const maxSpare = Math.max(3, Math.round(maxChildren / 2));
  const memoryLimit = clamp(s.memoryLimitMb ?? 256, 32, 4096);
  const maxExecution = clamp(s.maxExecutionTime ?? 120, 10, 900);
  const uploadMb = clamp(s.uploadMaxFilesizeMb ?? 64, 1, 2048);
  const disabled = [...new Set([...BASE_DISABLED_FUNCTIONS, ...(s.disabledFunctions || [])])]
    .filter((f) => /^[a-z_][a-z0-9_]*$/i.test(f));

  const root = siteRoot(slug);
  const user = site.siteUser || `xfm_${slug}`;
  const sock = phpSocketPath(slug);

  return `; ------------------------------------------------------------------
; 由 XFMPanel 自动生成，请勿手工修改
; site: ${slug}  php: ${version}
; ------------------------------------------------------------------
[xfm_${slug}]
user = ${user}
group = ${user}
listen = ${sock}
listen.owner = www-data
listen.group = www-data
listen.mode = 0660

pm = dynamic
pm.max_children = ${maxChildren}
pm.start_servers = ${startServers}
pm.min_spare_servers = ${minSpare}
pm.max_spare_servers = ${maxSpare}
pm.max_requests = 500
request_terminate_timeout = ${maxExecution + 30}s

chdir = ${root}
catch_workers_output = yes
decorate_workers_output = no

; ---- 隔离与安全 ----
php_admin_value[open_basedir] = ${root}:/tmp
php_admin_value[disable_functions] = ${disabled.join(',')}
php_admin_value[upload_tmp_dir] = ${root}/tmp
php_admin_value[sys_temp_dir] = ${root}/tmp
php_admin_value[session.save_path] = ${root}/tmp
php_admin_value[max_execution_time] = ${maxExecution}
php_admin_value[memory_limit] = ${memoryLimit}M
php_admin_value[upload_max_filesize] = ${uploadMb}M
php_admin_value[post_max_size] = ${uploadMb}M
php_admin_value[expose_php] = Off
php_admin_value[cgi.fix_pathinfo] = 0
php_admin_value[error_log] = ${siteLogDir(slug)}/php-error.log
php_admin_flag[log_errors] = on
php_admin_flag[display_errors] = off
`;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(Math.round(v), min), max);
}

/** 站点目录权限初始化脚本（由 agent 落盘执行，非 shell 字符串拼接） */
export function siteDirPlan(slug, user) {
  return [
    { path: siteRoot(slug), mode: '0755', owner: user },
    { path: `${siteRoot(slug)}/public`, mode: '0755', owner: user },
    { path: `${siteRoot(slug)}/logs`, mode: '0750', owner: user },
    { path: `${siteRoot(slug)}/tmp`, mode: '0750', owner: user },
    { path: `${siteRoot(slug)}/backup`, mode: '0700', owner: user },
    { path: siteLogDir(slug), mode: '0750', owner: user },
  ];
}
