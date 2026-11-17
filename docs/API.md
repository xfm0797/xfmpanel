# 接口设计

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `https://<panel>/api/v1` |
| 编码 | 请求与响应均为 `application/json; charset=utf-8`（`text/event-stream` 除外） |
| 认证 | 会话 Cookie `xfm_sid`（HttpOnly, SameSite=Lax, HTTPS 下 Secure） |
| CSRF | 非 `GET/HEAD` 请求必须带 `X-CSRF-Token`（登录接口除外，仍校验 Origin） |
| 请求体上限 | 1MB（上传证书的 PEM 文本足够） |
| 幂等 | `GET`/`DELETE` 幂等；创建类接口重复提交由唯一约束与任务互斥兜底 |
| 追踪 | 响应头 `X-Request-Id`，出错时响应体同名字段，便于对照日志 |

### 1.1 成功响应

```json
{ "ok": true, "data": { "...": "..." } }
```

列表型 `data` 统一为 `{ "items": [], "total": 0, "page": 1, "size": 20 }`。

### 1.2 失败响应

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "至少需要一个域名",
    "field": "domains"
  },
  "requestId": "0c1f..."
}
```

### 1.3 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 未登录或会话失效 |
| `AUTH_FAILED` | 401 | 用户名或密码错误 |
| `ACCOUNT_LOCKED` | 423 | 失败次数过多，临时锁定 |
| `CSRF_INVALID` | 403 | CSRF 令牌缺失/不匹配或来源非法 |
| `FORBIDDEN` | 403 | 角色权限不足 |
| `VALIDATION_FAILED` | 422 | 参数校验失败（带 `field`） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 状态冲突（域名重复、依赖未安装等） |
| `TASK_CONFLICT` | 409 | 同一对象已有进行中的任务 |
| `RATE_LIMITED` | 429 | 请求过于频繁（`Retry-After: 60`） |
| `AGENT_UNAVAILABLE` | 503 | agent 不可达/超时 |
| `AGENT_REJECTED` | 502 | agent 拒绝执行（校验/命令失败） |
| `UPSTREAM_FAILED` | 502 | 外部依赖失败（apt/certbot） |
| `INTERNAL` | 500 | 未预期错误（详情仅入日志） |

### 1.4 分页

`?page=1&size=20`（`size` 上限 100，站点/告警列表允许 200）。

## 2. 认证

### POST /auth/login

```json
{ "username": "admin", "password": "..." }
```

200：

```json
{
  "ok": true,
  "data": {
    "user": { "id": 1, "username": "admin", "role": "owner", "permissions": ["*"] },
    "csrfToken": "…",
    "expiresAt": "2026-11-18T10:00:00.000Z"
  }
}
```

失败：`401 AUTH_FAILED`；连续失败达阈值后 `423 ACCOUNT_LOCKED`。

### GET /auth/me

返回当前用户、权限、CSRF 令牌与面板基础设置。前端启动时调用，用于判断是否已登录。

### POST /auth/logout

失效当前会话（服务端置 `revoked_at`），清除 Cookie。

### POST /auth/password

```json
{ "oldPassword": "...", "newPassword": "..." }
```

成功后除当前会话外的所有会话被吊销。

## 3. 站点

### GET /sites

查询参数：`q`（名称/域名/标识）、`status`、`appType`、`page`、`size`。

```json
{
  "items": [{
    "id": 3, "slug": "company-site", "name": "company-site",
    "domain": "www.xfm-demo.com", "aliases": ["xfm-demo.com"],
    "appType": "php", "phpVersion": "8.3",
    "rootPath": "/www/xfm/company-site", "siteUser": "xfm_company-site",
    "status": "active", "desiredState": "running", "sslMode": "acme",
    "settings": { "rewrite": "wordpress", "clientMaxBodySizeMb": 128 },
    "certStatus": "issued", "certNotAfter": "2027-02-15T…"
  }],
  "total": 3, "page": 1, "size": 20
}
```

### POST /sites

```json
{
  "name": "公司官网",
  "slug": "company-site",
  "domains": ["www.example.com", "example.com"],
  "appType": "php",
  "phpVersion": "8.3",
  "sslMode": "acme",
  "remark": "WordPress",
  "settings": { "rewrite": "wordpress", "clientMaxBodySizeMb": 128 }
}
```

201：

```json
{
  "ok": true,
  "data": {
    "site": { "id": 4, "status": "pending", "...": "..." },
    "task": { "id": "uuid", "type": "site.create", "status": "queued", "title": "创建站点 …" }
  }
}
```

常见错误：`409`（域名已被占用 / 标识重复 / PHP 未安装 / 未安装 Nginx）、`422`（域名或标识格式错误）。

### GET /sites/:id

返回站点详情 + 证书列表 + 最近 10 个任务。

### PATCH /sites/:id

可局部更新：`name`、`domains`、`appType`、`phpVersion`、`upstream`、`settings`、`sslMode`、`status`（active/stopped）、`remark`。
副作用：写入后自动创建 `site.apply` 任务并重建配置。

### POST /sites/:id/state

```json
{ "status": "stopped" }
```

停用 = 移除 `sites-enabled` 软链并 reload；文件保留。启用为反向操作。

### POST /sites/:id/reload

仅重载 nginx（及对应 php-fpm），不重建配置，用于排障。

### GET /sites/:id/config

返回与 agent 落盘**完全同源**的渲染结果：

```json
{ "spec": {...}, "vhost": "# 由 XFMPanel 自动生成…", "pool": "; 由 XFMPanel 自动生成…" }
```

### GET /sites/:id/logs?type=access|error|php&lines=200

```json
{ "type": "access", "slug": "company-site", "lines": ["10.0.0.5 - - [...]"], "file": "/var/log/xfmpanel/sites/company-site/access.log" }
```

### GET /sites/:id/dns-check

逐域名返回 A/AAAA 记录与是否解析，用于签发前预检。

### GET /sites/:id/usage

目录占用（MB）与文件数（最多统计 5 万个文件）。

### DELETE /sites/:id?keepFiles=1&backup=1

- `keepFiles=1`（默认）：只删配置与数据库记录，保留站点文件
- `backup=1`（默认）：删除前打包到 `/var/backups/xfmpanel/`

返回 `{ site, task }`，站点状态立即变为 `deleting`。

## 4. 网站环境

### GET /runtimes

```json
{
  "groups": [{
    "kind": "php", "label": "PHP-FPM", "description": "…",
    "versions": [{ "version": "8.3", "label": "8.3 推荐", "recommended": true }],
    "installed": [{ "id": 2, "version": "8.3", "status": "active", "isDefault": true, "serviceName": "php8.3-fpm" }],
    "hasActive": true
  }],
  "installed": [],
  "pendingTasks": []
}
```

### POST /runtimes/install

```json
{ "kind": "php", "version": "8.3" }
```

202 `{ task }`。已安装且运行中返回 `409 CONFLICT`。

### POST /runtimes/:id/default

将同类组件的默认版本切换为该实例。

### POST /runtimes/:id/service

```json
{ "action": "restart" }   // start | stop | restart | reload
```

### DELETE /runtimes/:id

存在站点引用时拒绝（`409`），并创建卸载任务。MariaDB 数据目录不会被删除。

### GET /runtimes/health

并发查询各 systemd 单元状态：`{ services: [{ id, kind, version, unit, active, since }] }`。

## 5. 证书

### GET /certificates?status=&siteId=&q=

```json
[{
  "id": 1, "siteId": 3, "domain": "www.xfm-demo.com", "altNames": ["xfm-demo.com"],
  "provider": "acme", "status": "issued",
  "notAfter": "2027-02-15T…", "daysLeft": 89, "autoRenew": true,
  "issuer": "Let's Encrypt (Stub)", "lastError": null
}]
```

### POST /certificates/issue

```json
{ "siteId": 3, "domains": ["www.example.com", "example.com"], "force": false }
```

202 `{ task, certId }`。若已有有效证书且 `force=false` 返回 `409`。

### POST /certificates/:id/renew

手动续期（`--force-renewal`）。自动续期由调度器每 6 小时扫描 `not_after - 30 天` 触发。

### POST /certificates/:id/revoke

吊销并回退站点到 HTTP（重建 vhost，去掉 443）。

### POST /certificates/upload

```json
{ "siteId": 3, "domain": "example.com", "certPem": "-----BEGIN CERTIFICATE-----…", "keyPem": "-----BEGIN PRIVATE KEY-----…" }
```

agent 侧校验：PEM 可解析、未过期、私钥与证书公钥匹配，私钥以 `0600` 落盘。

### POST /certificates/scan

立即执行一次巡检与续期入队，返回 `{ checked, changed, scanned, queued }`。

### GET /certificates/stats

`{ total, byStatus, soon: [{ domain, notAfter, daysLeft, autoRenew }] }`。

## 6. 任务

### GET /tasks?status=&type=&targetType=&targetId=&page=&size=

按创建时间倒序，返回 `items/total/page/size`。

### GET /tasks/:id

任务详情 + 最近 200 条事件。

### GET /tasks/:id/events?after=<seq>（SSE）

```
event: meta
data: {"taskId":"…","status":"running","type":"site.create","title":"创建站点 …"}

event: log
data: {"taskId":"…","seq":7,"level":"info","message":"[45%] 写入 vhost …","at":"2026-11-17T…"}

event: done
data: {"status":"success","progress":100}
```

- 先补发 `after` 之后的历史事件，再推送增量；
- 客户端断线重连时带最后一次 `seq` 即可无缝续传；
- 服务端每 15s 发注释帧 `: ping` 保活；
- 任务结束立即发 `done` 并关闭连接（nginx 侧需关闭缓冲，见 `deploy/nginx/xfmpanel.conf`）。

### POST /tasks/:id/cancel

仅 `queued/running` 可取消；运行中任务通过 `AbortController` 中断 agent 调用。

## 7. 日志、系统、告警、用户、设置

| 端点 | 说明 |
| --- | --- |
| `GET /logs/panel?lines=&level=` | 面板 JSON 行日志尾部 |
| `GET /logs/audit?action=&actor=&result=&page=` | 审计分页查询 |
| `GET /system/health` | 无需登录的探活：`{ panel, agent, db, uptimeSec }` |
| `GET /system/overview` | 概览聚合：主机信息（含本机 IPv4/IPv6 地址）、服务健康、站点/证书/任务统计、未确认告警数 |
| `GET /system/metrics` | 实时指标：CPU / 内存 / 磁盘 / 网络 + 最近 15 分钟序列（`refresh=1` 可强制立即采样） |
| `GET /system/paths` | 关键路径与运行模式（排障用） |
| `GET /alerts?open=1&level=&source=` | 告警列表 + `openCount` |
| `POST /alerts/:id/ack` | 确认告警 |
| `GET /users` | 用户列表 + 角色权限矩阵（仅 owner） |
| `POST /users` | 创建用户 `{ username, password, displayName, role }` |
| `PATCH /users/:id` | 改角色/状态/重置密码（会踢出会话） |
| `DELETE /users/:id` | 删除用户（不能删自己，不能删最后一个 owner） |
| `GET /settings` | 全部设置 + 前端表单 schema |
| `PATCH /settings` | 批量更新 `{ "cert.email": "ops@example.com" }` |

### 7.1 `/system/metrics` 响应

```json
{
  "ok": true,
  "data": {
    "available": true,
    "error": null,
    "intervalMs": 5000,
    "windowMinutes": 15,
    "collectedAt": "2026-11-17T14:41:25.557Z",
    "current": {
      "at": 1794926485557,
      "uptimeSec": 2819,
      "cpu": { "usage": 12.8, "cores": 4, "loadavg": [0.42, 0.31, 0.28], "loadPercent": 10.5, "model": "Intel(R) Xeon(R) ..." },
      "mem": { "totalBytes": 17037406208, "usedBytes": 6210908160, "usagePercent": 36.5, "swapUsedBytes": 0 },
      "disk": { "totalBytes": 85899345920, "usedBytes": 33285996544, "freeBytes": 52613349376, "usagePercent": 38.8 },
      "net": { "iface": "eth0", "rxBps": 127063, "txBps": 57447, "rxTotal": 1284000000, "txTotal": 392000000 }
    },
    "series": [
      { "t": 1794926485557, "cpu": 12.8, "mem": 36.5, "disk": 38.8, "rx": 127063, "tx": 57447 }
    ]
  }
}
```

- `series` 为最近 15 分钟的滑动窗口（5s × 180 点），只存在面板内存中，重启即清空。
- agent 不可用时返回 `available: false` 与 `error` 文案，`current`/`series` 可能为空，前端据此展示空状态。
- CPU 与网络是增量指标，agent 侧每秒差分计算；面板侧不做任何系统探测。

## 8. curl 快速上手
```bash
BASE=http://127.0.0.1:8787/api/v1
JAR=/tmp/xfm.cookie

# 1) 登录（保存 Cookie，取 CSRF）
CSRF=$(curl -s -c $JAR -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASS"}' | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')

# 2) 安装 Nginx
curl -s -b $JAR -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -X POST $BASE/runtimes/install -d '{"kind":"nginx","version":"1.26"}'

# 3) 创建站点（自动申请证书）
curl -s -b $JAR -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -X POST $BASE/sites -d '{
    "name":"demo","domains":["demo.example.com"],
    "appType":"php","phpVersion":"8.3","sslMode":"acme"
  }'

# 4) 看任务实时输出
curl -N -b $JAR $BASE/tasks/<taskId>/events

# 5) 配置预览
curl -s -b $JAR $BASE/sites/1/config | head -40
```

## 9. 限流与并发

| 维度 | 限制 | 位置 |
| --- | --- | --- |
| 单 IP 每分钟请求 | 240（`XFMP_RATE_LIMIT`） | `http/security.js` |
| 登录失败 | 5 次/IP/用户名 → 锁 15 分钟 | `routes/auth.js` + `login_throttle` |
| 任务并发 | 2（`XFMP_TASK_CONCURRENCY`） | `services/tasks.js` |
| 同站点变更 | 串行（不允许并发任务） | `services/tasks.js` |
| SSE 连接 | 每任务独立，最长 1 小时（nginx 侧） | `deploy/nginx/xfmpanel.conf` |
