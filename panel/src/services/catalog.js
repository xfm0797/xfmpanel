/**
 * 支持安装的网站环境目录（软件源与包名在 agent 侧按发行版决定）。
 * 版本列表是“面板允许用户选择的集合”，实际可用性由 agent 安装时校验。
 */

export const CATALOG = {
  nginx: {
    kind: 'nginx',
    label: 'Nginx',
    description: 'Web 服务器 / 反向代理，站点 vhost 由其承载',
    serviceName: 'nginx',
    required: true,
    versions: [
      { version: '1.26', label: '1.26 主线稳定', recommended: true },
      { version: '1.24', label: '1.24 稳定' },
    ],
    configHints: ['/etc/nginx/nginx.conf', '/etc/nginx/sites-available'],
  },
  php: {
    kind: 'php',
    label: 'PHP-FPM',
    description: '每个站点独立 pool 与系统用户，禁用危险函数',
    servicePattern: 'php{version}-fpm',
    versions: [
      { version: '8.4', label: '8.4 最新' },
      { version: '8.3', label: '8.3 推荐', recommended: true },
      { version: '8.2', label: '8.2 稳定' },
      { version: '8.1', label: '8.1 兼容' },
      { version: '7.4', label: '7.4 老项目' },
    ],
    extensions: ['fpm', 'mysql', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'bcmath', 'opcache', 'redis'],
  },
  mariadb: {
    kind: 'mariadb',
    label: 'MariaDB',
    description: '数据库，仅监听 127.0.0.1',
    serviceName: 'mariadb',
    versions: [
      { version: '11.4', label: '11.4 LTS', recommended: true },
      { version: '10.11', label: '10.11 LTS' },
    ],
  },
  redis: {
    kind: 'redis',
    label: 'Redis',
    description: '对象缓存 / 会话存储，绑定本机并设置密码',
    serviceName: 'redis-server',
    versions: [
      { version: '7.2', label: '7.2 稳定', recommended: true },
      { version: '6.2', label: '6.2 兼容' },
    ],
  },
  nodejs: {
    kind: 'nodejs',
    label: 'Node.js',
    description: '用于 Node 应用的运行环境（配合 proxy 站点）',
    versions: [
      { version: '22', label: '22 LTS', recommended: true },
      { version: '20', label: '20 LTS' },
    ],
  },
};

export function listCatalog() {
  return Object.values(CATALOG);
}

export function findCatalogItem(kind) {
  return CATALOG[kind] || null;
}

export function isValidVersion(kind, version) {
  const item = CATALOG[kind];
  if (!item) return false;
  return item.versions.some((v) => v.version === String(version));
}

export function serviceNameFor(kind, version) {
  if (kind === 'php') return `php${version}-fpm`;
  if (kind === 'nodejs') return null;
  return CATALOG[kind]?.serviceName || kind;
}
