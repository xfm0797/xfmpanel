# 数据库设计

## 1. 选型与约定

| 决策 | 理由 |
| --- | --- |
| SQLite（`node:sqlite`，WAL 模式） | 单机面板并发量级小（几十 QPS），单文件免运维；WAL 下读写不互斥；备份 = 复制文件 |
| 时间统一 `TEXT` ISO8601 (UTC) | 可排序、可跨时区展示，前端按本地时区格式化 |
| 布尔用 `INTEGER 0/1` | SQLite 无原生布尔 |
| 结构化字段用 `TEXT` 存 JSON | 站点 settings、证书 SAN、审计 detail；SQLite 内置 JSON1 可查询 |
| 主键 | 多数表 `INTEGER PRIMARY KEY AUTOINCREMENT`；任务/会话用字符串（uuid / sha256） |
| 外键 | `PRAGMA foreign_keys = ON`，删除站点级联清理域名与证书 |

ER 概览：

```
users 1──n sessions
users 1──n audit_logs
users 1──n sites (created_by, SET NULL)
sites 1──n site_domains
sites 1──n certificates 1──n cert_checks
sites 1──n backups
tasks 1──n task_events
runtimes (独立，按 kind+version 唯一)
alerts / settings / login_throttle (独立)
```

## 2. 表结构

### 2.1 users — 账号

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| username | TEXT UNIQUE | 登录名 |
| display_name | TEXT | 展示名 |
| password_hash | TEXT | `scrypt$N$r$p$salt$hash` |
| role | TEXT | `owner` / `admin` / `operator` / `viewer` |
| status | TEXT | `active` / `disabled` |
| failed_attempts | INTEGER | 连续失败次数，成功后清零 |
| locked_until | TEXT | 锁定到期时间 |
| last_login_at / last_login_ip | TEXT | 最近登录 |
| password_changed_at | TEXT | 改密时间（可用于强制过期策略） |
| created_at / updated_at | TEXT | |

索引：`idx_users_role(role)`。业务约束（应用层）：至少保留一个 `active` 的 owner。

### 2.2 sessions — 会话

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `sha256(token)`，库泄漏也无法冒用 |
| user_id | INTEGER FK→users CASCADE | |
| csrf_token | TEXT | 每会话独立 CSRF 令牌 |
| ip / user_agent | TEXT | 审计与异常排查 |
| created_at / last_seen_at / expires_at | TEXT | 滑动过期（5 分钟粒度更新） |
| revoked_at | TEXT | 登出/改密/禁用时置位 |

索引：`idx_sessions_user`、`idx_sessions_exp`。每天清理过期 24h 以上的记录。

### 2.3 login_throttle — 登录节流

| 字段 | 说明 |
| --- | --- |
| key | TEXT PK，`ip:1.2.3.4` 或 `user:admin` |
| count | 失败次数 |
| first_at | 首次失败时间 |
| blocked_until | 锁定到期时间 |

独立成表的原因：进程重启不清零，且可同时按 IP 与用户名两个维度限速。

### 2.4 runtimes — 网站环境组件

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| kind | TEXT | `nginx` / `php` / `mariadb` / `redis` / `nodejs` |
| version | TEXT | 如 `8.3`、`1.26` |
| status | TEXT | `not_installed` / `installing` / `active` / `stopped` / `failed` |
| is_default | INTEGER | 同类组件默认版本（每个 kind 至多一个 1） |
| service_name | TEXT | systemd unit，如 `php8.3-fpm` |
| install_path / config_path | TEXT | 安装目录与主配置 |
| meta | TEXT(JSON) | 扩展列表、端口、Redis 密码等 |
| last_error | TEXT | 安装/启动失败原因 |
| installed_at / created_at / updated_at | TEXT | |

唯一约束：`UNIQUE(kind, version)`；索引 `idx_runtimes_kind(kind, status)`。

### 2.5 sites — 站点

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| slug | TEXT UNIQUE | 目录/用户/文件名，`^[a-z][a-z0-9-]{1,30}[a-z0-9]$` |
| name | TEXT | 展示名 |
| domain | TEXT UNIQUE | 主域名 |
| aliases | TEXT(JSON) | 域名别名数组 |
| root_path | TEXT | 固定 `/www/xfm/<slug>` |
| site_user | TEXT | `xfm_<slug>`，nologin |
| app_type | TEXT | `php` / `static` / `proxy` |
| php_version | TEXT | 仅 php 类型 |
| upstream | TEXT | 仅 proxy 类型，限本机地址 |
| status | TEXT | `pending` / `active` / `stopped` / `error` / `deleting` |
| desired_state | TEXT | `running` / `stopped`（期望状态，配置幂等的依据） |
| ssl_mode | TEXT | `none` / `acme` / `manual` |
| settings | TEXT(JSON) | 伪静态、上传大小、FPM 进程数、内存、禁用函数等 |
| remark | TEXT | 备注 |
| last_error | TEXT | 最近一次失败原因（前端直接展示） |
| created_by | INTEGER FK→users SET NULL | |
| created_at / updated_at | TEXT | |

索引：`idx_sites_status`、唯一索引 `idx_sites_domain`。

`status` 与 `desired_state` 分离的原因：用户点"停用"后需要一次异步任务才会真正移除 vhost，期间状态是 `pending`，期望状态已变为 `stopped`；任务完成后再落 `stopped`。这样任务重试天然幂等。

settings 允许的键（白名单，服务层 clamp）：

```json
{
  "rewrite": "none|wordpress|laravel|thinkphp|discuz",
  "clientMaxBodySizeMb": 1..4096,
  "maxChildren": 2..80,
  "memoryLimitMb": 32..4096,
  "maxExecutionTime": 10..900,
  "uploadMaxFilesizeMb": 1..2048,
  "forceHttps": true,
  "disabledFunctions": ["exec", "shell_exec"]
}
```

### 2.6 site_domains — 域名索引

| 字段 | 说明 |
| --- | --- |
| id | PK |
| site_id | FK→sites CASCADE |
| domain | TEXT UNIQUE，跨站点唯一 |
| is_primary | 0/1 |

用途：域名解析到站点时可直接索引命中，也用于创建时快速判重。

### 2.7 certificates — 证书

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| site_id | FK→sites CASCADE | |
| domain | TEXT | 主域名，`UNIQUE(site_id, domain)` |
| alt_names | TEXT(JSON) | SAN 列表 |
| provider | TEXT | `acme` / `upload` |
| status | TEXT | `pending` / `issued` / `expiring` / `expired` / `failed` / `revoked` |
| cert_path / key_path / fullchain_path | TEXT | 证书文件路径（letsencrypt 或 /etc/xfmpanel/certs） |
| issuer / not_before / not_after / fingerprint | TEXT | 证书元数据 |
| auto_renew | INTEGER | 是否自动续期（上传证书默认 0） |
| last_renew_at / renew_attempts | TEXT / INTEGER | 续期历史 |
| last_error | TEXT | 失败原因（前端展示） |
| created_at / updated_at | TEXT | |

索引：`idx_certs_status(status, not_after)`（巡检按到期时间扫描）。

### 2.8 tasks — 任务

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | uuid |
| type | TEXT | `site.create` / `site.apply` / `site.remove` / `runtime.install` / `cert.issue` … |
| target_type / target_id | TEXT | 如 `site` / `42`，用于互斥与查询 |
| title | TEXT | 人类可读标题 |
| status | TEXT | `queued` / `running` / `success` / `failed` / `canceled` |
| priority | INTEGER | 越小越先（安装=1，删除=2，建站=3） |
| progress | INTEGER | 0–100 |
| payload | TEXT(JSON) | 入参快照 |
| result / error | TEXT | 结果与错误 |
| created_by | FK→users SET NULL | |
| started_at / finished_at / created_at | TEXT | |

索引：`idx_tasks_status(status, priority, created_at)`、`idx_tasks_target(target_type, target_id)`。

### 2.9 task_events — 任务事件（日志流）

| 字段 | 说明 |
| --- | --- |
| id | PK |
| task_id | FK→tasks CASCADE |
| seq | 任务内自增序号，SSE 断线重连续传依据 |
| level | `info` / `warn` / `error` / `success` |
| message | 单行文本，最长 4000 字符 |
| at | 时间 |

索引：`idx_task_events_task(task_id, seq)`。任务删除时级联清理；`XFMP_TASK_RETENTION_DAYS` 控制保留天数。

### 2.10 audit_logs — 审计

| 字段 | 说明 |
| --- | --- |
| id | PK |
| actor_id / actor_name | 操作者（system 表示定时任务） |
| action | `site.create`、`cert.renew`、`auth.login_failed` … |
| resource / resource_id | 资源类型与 ID |
| result | `success` / `failed` |
| ip / user_agent | 来源 |
| detail | JSON：变更字段、任务 ID 等 |
| at | 时间 |

索引：`idx_audit_at`、`idx_audit_action`。只增不改，用于事后追责。

### 2.11 alerts — 告警

| 字段 | 说明 |
| --- | --- |
| id | PK |
| level | `info` / `warning` / `critical` |
| source | `cert` / `site` / `runtime` / `task` / `system` |
| code | 稳定的告警码，如 `CERT_EXPIRED` |
| title / message | 展示文案 |
| resource | 关联资源，如 `cert:12` |
| dedupe_key | 去重键 |
| acknowledged / ack_by / ack_at | 确认状态 |
| created_at / updated_at | |

唯一部分索引：`idx_alerts_dedupe(dedupe_key) WHERE acknowledged = 0` —— 同一问题在未确认期间只保留一条，条件恢复后由 `alerts.resolve()` 自动关闭。

### 2.12 backups — 站点备份记录

| 字段 | 说明 |
| --- | --- |
| site_id | FK→sites CASCADE |
| path | tar.gz 绝对路径（`/var/backups/xfmpanel/`） |
| size_bytes | 大小 |
| status | `success` / `failed` |
| created_at | 时间 |

注意：删除站点会级联删除备份记录，但**不会删除磁盘上的 tar.gz**（故意的：给误删留后路）。

### 2.13 settings — 键值设置

| 字段 | 说明 |
| --- | --- |
| key | PK，如 `cert.email`、`site.defaultPhpVersion` |
| value | 统一以字符串存储，服务层按 schema 校验 |
| updated_at / updated_by | 审计信息 |

### 2.14 cert_checks — 巡检流水

| 字段 | 说明 |
| --- | --- |
| cert_id | FK→certificates CASCADE |
| checked_at | 巡检时间 |
| days_left | 剩余天数（负数表示已过期） |
| action | 当时判定的状态（issued/expiring/expired） |

用于回溯"为什么没有自动续期"这类问题。

## 3. 状态机汇总

```
sites.status:        pending ──▶ active ⇄ stopped
                        └──▶ error ──(重试/修改)──▶ pending
                        └──▶ deleting ──▶ (行删除)

certificates.status: pending ──▶ issued ⇄ expiring ──▶ expired
                        └──▶ failed ──(重试)──▶ pending
                        └──▶ revoked

tasks.status:        queued ──▶ running ──▶ success | failed | canceled
```

## 4. 常用查询

```sql
-- 临期证书（巡检）
SELECT id, domain, not_after FROM certificates
WHERE status IN ('issued','expiring') AND not_after < datetime('now','+30 day')
ORDER BY not_after;

-- 站点及其证书状态（列表页）
SELECT s.*, c.status AS cert_status, c.not_after
FROM sites s LEFT JOIN certificates c
  ON c.site_id = s.id AND c.status IN ('issued','expiring')
ORDER BY s.id DESC;

-- 未确认告警数（侧边栏红点）
SELECT COUNT(*) FROM alerts WHERE acknowledged = 0;

-- 某站点是否有进行中的任务（互斥判断）
SELECT id, type FROM tasks
WHERE target_type = 'site' AND target_id = ?
  AND status IN ('queued','running');
```

## 5. 备份与恢复

```bash
# 在线备份（WAL 模式下安全）
sqlite3 /var/lib/xfmpanel/xfmpanel.db ".backup '/root/xfm-$(date +%F).db'"

# 或直接停服务后复制三件套
systemctl stop xfmpanel-panel
cp /var/lib/xfmpanel/xfmpanel.db* /root/backup/
systemctl start xfmpanel-panel
```

恢复：停服务 → 覆盖 `.db` → 删除 `-wal`/`-shm` → 启动。迁移文件会在启动时自动补齐，版本不一致会报错而不会静默改表。

## 6. 容量与清理

| 表 | 增长源 | 策略 |
| --- | --- | --- |
| task_events | 每任务几十~几百行 | 随任务按 `taskRetentionDays`（默认 30 天）级联删除 |
| audit_logs | 每次写操作一行 | 建议每年归档一次（导出 CSV 后删除旧记录） |
| cert_checks | 每证书每 6 小时一行 | 可定期删除 90 天前记录 |
| sessions | 每次登录一行 | 每日清理过期 24h 以上 |

单站点、单日典型写入量 < 1MB，SQLite 在 GB 级仍可平稳运行。
