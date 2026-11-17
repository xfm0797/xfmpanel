/**
 * 面板与 agent 共用的路径约定。
 *
 * 所有站点相关路径都被限制在固定前缀之下，agent 侧对最终 realpath 再做一次
 * 前缀校验，避免 "../" 逃逸到系统目录。
 */

export const PATHS = {
  // 站点根目录：/www/xfm/<slug>
  WWW_ROOT: '/www/xfm',
  // 站点日志：/var/log/xfmpanel/sites/<slug>/{access,error}.log
  SITE_LOG_ROOT: '/var/log/xfmpanel/sites',
  // 证书：/etc/xfmpanel/certs/<slug>/
  CERT_ROOT: '/etc/xfmpanel/certs',
  // 备份：/var/backups/xfmpanel/
  BACKUP_ROOT: '/var/backups/xfmpanel',
  // nginx vhost
  NGINX_AVAILABLE: '/etc/nginx/sites-available',
  NGINX_ENABLED: '/etc/nginx/sites-enabled',
  // php-fpm pool
  PHP_POOL_DIR: '/etc/php',
  PHP_RUN_DIR: '/run/php',
  // 面板自身
  PANEL_CONF_DIR: '/etc/xfmpanel',
  PANEL_STATE_DIR: '/var/lib/xfmpanel',
  PANEL_LOG_DIR: '/var/log/xfmpanel',
  AGENT_SOCKET: '/run/xfmpanel/agent.sock',
  AGENT_SECRET: '/etc/xfmpanel/agent.secret',
};

export const SITE_DIRS = ['public', 'logs', 'tmp', 'backup', 'ssl'];

/** 生成站点根目录（slug 已通过校验） */
export function siteRoot(slug) {
  return `${PATHS.WWW_ROOT}/${slug}`;
}

export function sitePublicRoot(slug) {
  return `${PATHS.WWW_ROOT}/${slug}/public`;
}

export function siteLogDir(slug) {
  return `${PATHS.SITE_LOG_ROOT}/${slug}`;
}

export function siteCertDir(slug) {
  return `${PATHS.CERT_ROOT}/${slug}`;
}

export function nginxVhostPath(slug) {
  return `${PATHS.NGINX_AVAILABLE}/xfm-${slug}.conf`;
}

export function phpPoolPath(phpVersion, slug) {
  return `${PATHS.PHP_POOL_DIR}/${phpVersion}/fpm/pool.d/xfm-${slug}.conf`;
}

export function phpSocketPath(slug) {
  return `${PATHS.PHP_RUN_DIR}/xfm-${slug}.sock`;
}

/** 站点系统用户名，Linux 用户名上限 32 字符 */
export function siteUser(slug) {
  return `xfm_${slug}`.slice(0, 32);
}
