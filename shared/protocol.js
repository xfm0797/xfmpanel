/**
 * 面板 <-> agent 的共享协议定义。
 *
 * 设计原则：
 * 1) 操作名（op）是封闭白名单，agent 侧只认识这里列出的 op；
 * 2) 每个 op 的入参在 agent 侧用 schema 二次校验（面板侧校验不作为信任边界）；
 * 3) 所有长任务都通过流式帧回传进度，帧格式见 FRAME 常量。
 */

export const PROTOCOL_VERSION = 1;

/** 帧类型（newline-delimited JSON） */
export const FRAME = {
  READY: 'ready',
  LOG: 'log',
  PROGRESS: 'progress',
  RESULT: 'result',
  ERROR: 'error',
};

/**
 * agent 可执行的操作白名单。
 * 说明：面板进程无 root，任何需要 root 的动作必须落到这些 op 上。
 */
export const AGENT_OPS = Object.freeze({
  PING: 'system.ping',
  SYSTEM_INFO: 'system.info',
  SYSTEM_METRICS: 'system.metrics',
  SERVICE_STATUS: 'service.status',
  SERVICE_ACTION: 'service.action',
  NGINX_TEST: 'nginx.test',
  NGINX_RELOAD: 'nginx.reload',
  RUNTIME_CATALOG: 'runtime.catalog',
  RUNTIME_INSTALL: 'runtime.install',
  RUNTIME_REMOVE: 'runtime.remove',
  SITE_APPLY: 'site.apply',
  SITE_PROVISION: 'site.provision',
  SITE_REMOVE: 'site.remove',
  SITE_BACKUP: 'site.backup',
  BACKUP_PRUNE: 'site.backup.prune',
  SITE_LOG_TAIL: 'site.log.tail',
  SITE_USAGE: 'site.usage',
  CERT_ISSUE: 'cert.issue',
  CERT_RENEW: 'cert.renew',
  CERT_REVOKE: 'cert.revoke',
  CERT_UPLOAD: 'cert.upload',
  CERT_INSPECT: 'cert.inspect',
  DNS_CHECK: 'dns.check',
  PANEL_LOG_TAIL: 'panel.log.tail',
});

/** agent 允许操作的 systemd 单元白名单（前缀匹配在 agent 侧校验） */
export const ALLOWED_UNITS = [
  'nginx',
  'mariadb',
  'mysql',
  'redis-server',
  'php',
];

/** 任务类型 -> 中文名（前端展示用） */
export const TASK_LABELS = {
  'runtime.install': '安装网站环境',
  'runtime.remove': '卸载运行环境',
  'site.create': '创建站点',
  'site.apply': '应用站点配置',
  'site.remove': '删除站点',
  'site.action': '站点操作',
  'site.backup': '站点备份',
  'cert.issue': '申请证书',
  'cert.renew': '续期证书',
  'cert.revoke': '吊销证书',
  'cert.upload': '上传证书',
};

/** 任务状态机：queued -> running -> success | failed | canceled */
export const TASK_STATUS = ['queued', 'running', 'success', 'failed', 'canceled'];
export const SITE_STATUS = ['pending', 'active', 'stopped', 'error', 'deleting'];
export const RUNTIME_STATUS = ['not_installed', 'installing', 'active', 'stopped', 'failed'];
export const CERT_STATUS = ['pending', 'issued', 'expiring', 'expired', 'failed', 'revoked'];

/** 角色与权限矩阵：面板只做“能/不能”，不做细粒度数据权限（单租户运维场景） */
export const ROLES = {
  owner: {
    label: '超级管理员',
    permissions: ['*'],
  },
  admin: {
    label: '管理员',
    permissions: [
      'site:read', 'site:write', 'site:delete',
      'runtime:read', 'runtime:write',
      'cert:read', 'cert:write',
      'task:read', 'task:cancel',
      'log:read', 'alert:read', 'alert:write',
      'settings:read',
    ],
  },
  operator: {
    label: '运维',
    permissions: [
      'site:read', 'site:write',
      'runtime:read',
      'cert:read', 'cert:write',
      'task:read',
      'log:read', 'alert:read',
    ],
  },
  viewer: {
    label: '只读',
    permissions: ['site:read', 'runtime:read', 'cert:read', 'task:read', 'log:read', 'alert:read'],
  },
};

export const ROLE_NAMES = Object.keys(ROLES);

/** 统一错误码（面板 -> 前端） */
export const ERROR_CODES = {
  AUTH_REQUIRED: { status: 401, message: '请先登录' },
  AUTH_FAILED: { status: 401, message: '用户名或密码错误' },
  ACCOUNT_LOCKED: { status: 423, message: '账号已被临时锁定，请稍后再试' },
  CSRF_INVALID: { status: 403, message: '请求校验失败，请刷新页面重试' },
  FORBIDDEN: { status: 403, message: '没有权限执行该操作' },
  VALIDATION_FAILED: { status: 422, message: '参数校验未通过' },
  NOT_FOUND: { status: 404, message: '资源不存在' },
  CONFLICT: { status: 409, message: '资源状态冲突' },
  RATE_LIMITED: { status: 429, message: '请求过于频繁，请稍后再试' },
  TASK_CONFLICT: { status: 409, message: '该对象已有进行中的任务' },
  AGENT_UNAVAILABLE: { status: 503, message: '系统代理不可用，请检查 xfmpanel-agent 服务' },
  AGENT_REJECTED: { status: 502, message: '系统代理拒绝了该操作' },
  UPSTREAM_FAILED: { status: 502, message: '外部依赖执行失败' },
  INTERNAL: { status: 500, message: '服务器内部错误' },
};

/** 审计动作名 */
export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  LOGIN_FAILED: 'auth.login_failed',
  PASSWORD_CHANGE: 'auth.password_change',
  SITE_CREATE: 'site.create',
  SITE_UPDATE: 'site.update',
  SITE_DELETE: 'site.delete',
  SITE_ACTION: 'site.action',
  RUNTIME_INSTALL: 'runtime.install',
  RUNTIME_REMOVE: 'runtime.remove',
  RUNTIME_ACTIVATE: 'runtime.activate',
  CERT_ISSUE: 'cert.issue',
  CERT_RENEW: 'cert.renew',
  CERT_REVOKE: 'cert.revoke',
  CERT_UPLOAD: 'cert.upload',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  SETTINGS_UPDATE: 'settings.update',
  TASK_CANCEL: 'task.cancel',
};
