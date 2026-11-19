/**
 * nginx vhost 渲染器（纯函数，可单测）。
 *
 * 安全约束：
 * - 所有动态字段在进入模板前都已通过 shared/validate 校验；
 * - 不接受“任意附加配置”字符串，重写规则只允许预设枚举，杜绝配置注入；
 * - 输出文件由 agent 原子写入 + nginx -t 预检 + 失败回滚。
 */

import { siteLogDir, sitePublicRoot, siteCertDir } from '../paths.js';

const REWRITE_SNIPPETS = {
  none: [],
  wordpress: [
    'location / { try_files $uri $uri/ /index.php?$args; }',
  ],
  laravel: [
    'location / { try_files $uri $uri/ /index.php?$query_string; }',
  ],
  thinkphp: [
    "location / { if (!-e $request_filename) { rewrite ^(.*)$ /index.php?s=$1 last; } }",
  ],
  discuz: [
    'location / { try_files $uri $uri/ /index.php?$query_string; }',
  ],
};

const SECURITY_HEADERS = [
  'add_header X-Content-Type-Options "nosniff" always;',
  'add_header X-Frame-Options "SAMEORIGIN" always;',
  'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  'add_header X-XSS-Protection "1; mode=block" always;',
];

function nginxSafePath(p) {
  if (!/^\/[A-Za-z0-9._\-/]*$/.test(p) || p.includes('..')) {
    throw new Error(`不安全的路径: ${p}`);
  }
  return p;
}

function indent(lines, pad = '    ') {
  return lines.map((l) => (l ? pad + l : l)).join('\n');
}

/**
 * @param {object} site 站点规格
 * @param {string} site.slug
 * @param {string[]} site.domains 首项为主域名
 * @param {string} site.rootPath 站点根目录（不含 public）
 * @param {string} site.appType php|static|proxy
 * @param {string|null} site.phpVersion
 * @param {string|null} site.phpSocket
 * @param {string|null} site.upstream 反向代理目标，如 http://127.0.0.1:3000
 * @param {object} site.ssl {enabled, certPath, keyPath, forceHttps}
 * @param {object} site.settings {clientMaxBodySizeMb, rewrite, gzip, accessLog}
 */
export function renderSiteVhost(site) {
  const slug = site.slug;
  const domains = site.domains || [];
  if (!domains.length) throw new Error('站点缺少域名');

  const root = nginxSafePath(sitePublicRoot(slug));
  const logDir = nginxSafePath(siteLogDir(slug));
  const rewrite = site.settings?.rewrite || 'none';
  const rewriteLines = REWRITE_SNIPPETS[rewrite];
  if (!rewriteLines) throw new Error(`未知的重写规则: ${rewrite}`);

  const bodySize = Math.min(Math.max(Number(site.settings?.clientMaxBodySizeMb) || 64, 1), 4096);
  const upstream = site.upstream ? String(site.upstream) : null;
  if (upstream && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(upstream)) {
    throw new Error('反向代理目标必须是本机地址');
  }

  const serverName = domains.join(' ');

  const common = [
    `root ${root};`,
    'index index.php index.html index.htm;',
    `client_max_body_size ${bodySize}m;`,
    '',
    `access_log ${logDir}/access.log combined;`,
    `error_log ${logDir}/error.log warn;`,
    '',
    ...SECURITY_HEADERS,
    '',
    'location = /favicon.ico { access_log off; log_not_found off; }',
    'location = /robots.txt  { access_log off; log_not_found off; }',
    '',
    'location ~ /\\.(?!well-known) { deny all; }',
    '',
  ];

  const phpBlock = site.appType === 'php'
    ? [
        'location ~ \\.php$ {',
        '    try_files $uri =404;',
        `    fastcgi_pass unix:${site.phpSocket};`,
        '    fastcgi_index index.php;',
        '    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
        '    fastcgi_read_timeout 120s;',
        '    include fastcgi_params;',
        '}',
        '',
        'location ~ /\\.(?!well-known).* { deny all; }',
        '',
      ]
    : [];

  const proxyBlock = site.appType === 'proxy'
    ? [
        'location / {',
        `    proxy_pass ${upstream};`,
        '    proxy_http_version 1.1;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Real-IP $remote_addr;',
        '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '    proxy_set_header X-Forwarded-Proto $scheme;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
        '    proxy_read_timeout 300s;',
        '}',
        '',
      ]
    : [];

  const body = [
    ...common,
    ...rewriteLines,
    ...(rewriteLines.length ? [''] : []),
    ...phpBlock,
    ...proxyBlock,
  ];

  const header = [
    '# ------------------------------------------------------------------',
    '# 由 XFMPanel 自动生成，请勿手工修改（面板会覆盖该文件）',
    `# site: ${slug}  app: ${site.appType}`,
    '# ------------------------------------------------------------------',
    '',
  ];

  const httpServer = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${serverName};`,
    '',
    indent(body).replace(/^/gm, ''),
    site.ssl?.enabled && site.ssl.forceHttps
      ? '    # 强制 HTTPS\n    if ($scheme = http) { return 301 https://$host$request_uri; }\n'
      : '',
    '}',
    '',
  ];

  const out = [...header, ...httpServer];

  if (site.ssl?.enabled && site.ssl.certPath && site.ssl.keyPath) {
    const cert = nginxSafePath(site.ssl.certPath);
    const key = nginxSafePath(site.ssl.keyPath);
    out.push(
      'server {',
      // 兼容 nginx 1.22/1.18（Debian 12 / Ubuntu 22.04 系统源版本）：
      // 不能使用 1.25.1 才引入的 `http2 on;`，否则 nginx -t 直接失败。
      '    listen 443 ssl http2;',
      '    listen [::]:443 ssl http2;',
      `    server_name ${serverName};`,
      '',
      `    ssl_certificate ${cert};`,
      `    ssl_certificate_key ${key};`,
      '    ssl_protocols TLSv1.2 TLSv1.3;',
      '    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;',
      '    ssl_prefer_server_ciphers off;',
      '    ssl_session_cache shared:XFMSsl:10m;',
      '    ssl_session_timeout 1d;',
      '    ssl_stapling on;',
      '    ssl_stapling_verify on;',
      '',
      '    add_header Strict-Transport-Security "max-age=31536000" always;',
      '',
      indent(body),
      '',
      '}',
      '',
    );
  }

  return out.join('\n');
}

/**
 * 证书续期挑战统一用 webroot 方式，落在站点根下的固定目录，
 * 避免 certbot 停 nginx（standalone 模式会中断业务）。
 */
export function acmeWebrootPath(slug) {
  return `${sitePublicRoot(slug)}/.well-known/acme-challenge`;
}

export function certPathsFor(slug, domain) {
  const dir = `${siteCertDir(slug)}`;
  const base = domain.replace(/[^a-z0-9.-]/gi, '_');
  return {
    dir,
    certPath: `${dir}/${base}.crt`,
    keyPath: `${dir}/${base}.key`,
    chainPath: `${dir}/${base}.chain.crt`,
    fullchainPath: `${dir}/${base}.fullchain.crt`,
  };
}

export { REWRITE_SNIPPETS };
