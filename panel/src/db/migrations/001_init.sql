-- ---------------------------------------------------------------------------
-- XFMPanel 初始 schema
-- 约定：
--   * 所有时间均为 ISO8601 UTC 字符串（便于 SQLite 排序与跨时区展示）
--   * 布尔值统一用 INTEGER 0/1
--   * 结构化字段用 TEXT 存 JSON，读取时在服务层解析
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- 用户与鉴权 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL DEFAULT '',
  password_hash   TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'operator',
  status          TEXT    NOT NULL DEFAULT 'active',      -- active | disabled
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  last_login_ip   TEXT,
  password_changed_at TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 会话：只存 token 的 sha256，泄漏库也无法直接冒用
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                          -- sha256(token)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT    NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- 登录失败节流（按 IP / 用户名），进程重启后仍然有效
CREATE TABLE IF NOT EXISTS login_throttle (
  key         TEXT PRIMARY KEY,                            -- ip:1.2.3.4 或 user:admin
  count       INTEGER NOT NULL DEFAULT 0,
  first_at    TEXT NOT NULL,
  blocked_until TEXT
);

-- 网站环境 / 运行时 ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS runtimes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,                          -- nginx | php | mariadb | redis | nodejs
  version       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'not_installed',
  is_default    INTEGER NOT NULL DEFAULT 0,                -- 同类组件中被站点默认选用
  service_name  TEXT,                                      -- systemd unit
  install_path  TEXT,
  config_path   TEXT,
  meta          TEXT    NOT NULL DEFAULT '{}',             -- JSON：扩展、参数、端口
  last_error    TEXT,
  installed_at  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE(kind, version)
);
CREATE INDEX IF NOT EXISTS idx_runtimes_kind ON runtimes(kind, status);

-- 站点 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL UNIQUE,                   -- 目录/用户/配置文件名
  name           TEXT    NOT NULL,
  domain         TEXT    NOT NULL,                          -- 主域名
  aliases        TEXT    NOT NULL DEFAULT '[]',             -- JSON 数组
  root_path      TEXT    NOT NULL,
  site_user      TEXT    NOT NULL,
  app_type       TEXT    NOT NULL DEFAULT 'php',             -- php | static | proxy
  php_version    TEXT,
  upstream       TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending',         -- pending|active|stopped|error|deleting
  desired_state  TEXT    NOT NULL DEFAULT 'running',         -- running | stopped（期望状态）
  ssl_mode       TEXT    NOT NULL DEFAULT 'none',            -- none | acme | manual
  settings       TEXT    NOT NULL DEFAULT '{}',
  remark         TEXT    NOT NULL DEFAULT '',
  last_error     TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);

CREATE TABLE IF NOT EXISTS site_domains (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain    TEXT    NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(domain)
);
CREATE INDEX IF NOT EXISTS idx_site_domains_site ON site_domains(site_id);

-- 证书 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  domain         TEXT    NOT NULL,
  alt_names      TEXT    NOT NULL DEFAULT '[]',
  provider       TEXT    NOT NULL DEFAULT 'acme',            -- acme | upload
  status         TEXT    NOT NULL DEFAULT 'pending',         -- pending|issued|expiring|expired|failed|revoked
  cert_path      TEXT,
  key_path       TEXT,
  fullchain_path TEXT,
  issuer         TEXT,
  not_before     TEXT,
  not_after      TEXT,
  fingerprint    TEXT,
  auto_renew     INTEGER NOT NULL DEFAULT 1,
  last_renew_at  TEXT,
  renew_attempts INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE(site_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_certs_status ON certificates(status, not_after);

-- 任务（长耗时操作统一异步化，带事件流） -----------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,                              -- uuid
  type        TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  title       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'queued',
  priority    INTEGER NOT NULL DEFAULT 5,
  progress    INTEGER NOT NULL DEFAULT 0,
  payload     TEXT    NOT NULL DEFAULT '{}',
  result      TEXT,
  error       TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target_type, target_id);

CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  level   TEXT    NOT NULL DEFAULT 'info',                   -- info|warn|error|success
  message TEXT    NOT NULL,
  at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, seq);

-- 审计日志 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_name  TEXT    NOT NULL DEFAULT 'system',
  action      TEXT    NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  result      TEXT    NOT NULL DEFAULT 'success',
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT    NOT NULL DEFAULT '{}',
  at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- 告警 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT    NOT NULL DEFAULT 'warning',             -- info|warning|critical
  source     TEXT    NOT NULL,                               -- cert|site|runtime|task|system
  code       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  message    TEXT    NOT NULL DEFAULT '',
  resource   TEXT,
  dedupe_key TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  ack_by     INTEGER,
  ack_at     TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(acknowledged, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key) WHERE acknowledged = 0;

-- 站点备份 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status     TEXT    NOT NULL DEFAULT 'success',
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_site ON backups(site_id, created_at);

-- 键值设置 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

-- 证书续期巡检记录（避免同一证书反复触发续期） ---------------------------
CREATE TABLE IF NOT EXISTS cert_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_id    INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  days_left  INTEGER,
  action     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cert_checks_cert ON cert_checks(cert_id, checked_at);
