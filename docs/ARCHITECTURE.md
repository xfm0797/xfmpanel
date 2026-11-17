# 架构设计

## 1. 总体结构

```
                    ┌─────────────────────────────────────────────┐
   浏览器 ──HTTPS──▶ │ nginx（反代 + TLS + 来源限制）               │
                    └───────────────┬─────────────────────────────┘
                                    │ http 127.0.0.1:8787
                    ┌───────────────▼─────────────────────────────┐
                    │ panel 进程（user: xfmpanel，无 root）        │
                    │                                             │
                    │  HTTP 内核 ── 安全中间件 ── 路由 ── 服务层    │
                    │        │                        │           │
                    │        │                  任务队列(worker)    │
                    │        ▼                        ▼           │
                    │      SQLite(WAL)          agent 客户端       │
                    └────────────────────────────────┬────────────┘
                                                     │ unix socket
                                                     │ 0660 root:xfmpanel
                                                     │ HMAC + nonce
                    ┌────────────────────────────────▼────────────┐
                    │ agent 进程（root）                           │
                    │  验签 → op 白名单 → 参数校验 → execFile      │
                    └───┬─────────┬──────────┬──────────┬─────────┘
                        │         │          │          │
                   systemctl   nginx -t   useradd     certbot / apt
```

关键约束：

1. **面板进程没有任何特权**，也无法执行任意命令；它只能调用 agent 暴露的 op。
2. **agent 不接受任意 shell**：全部 `spawn(cmd, argv)`；文件名/目录/域名先做白名单校验再落盘。
3. **证书与站点配置写入前先渲染、再校验（nginx -t）、失败回滚**，避免把坏配置留在磁盘。

## 2. 进程与权限边界

| 项 | panel | agent |
| --- | --- | --- |
| 运行用户 | `xfmpanel`（nologin） | `root` |
| 监听 | `127.0.0.1:8787`（有反代时）/ `0.0.0.0:8787`（无域名直连时） | `/run/xfmpanel/agent.sock`（0660） |
| 可写目录 | `/var/lib/xfmpanel`、`/var/log/xfmpanel` | 全系统（受 op 约束） |
| systemd 加固 | `ProtectSystem=strict`、`NoNewPrivileges`、`PrivateTmp` | `ProtectHome`、`ProtectKernelModules`，保留安装/服务管理所需权限 |
| 被攻破后的影响 | 可读数据库、可调用受限 op | 等价 root，但必须绕过 HMAC + 校验 |

密钥 `/etc/xfmpanel/agent.secret`（`0640 root:xfmpanel`）由安装脚本生成；agent 启动时长度不足会拒绝启动。

## 3. 核心模块划分

### 3.1 panel

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `src/server.js` | 启动、装配路由与中间件、任务 worker、定时巡检、优雅退出 | 收到 SIGTERM 先停 worker，再关连接与数据库 |
| `src/config.js` | 环境变量 → 不可变配置对象 | dev 自动切 stub agent 与 `./data` |
| `src/lib/http.js` | 路由匹配、上下文、JSON 解析、静态资源、统一错误、SSE | 单文件约 300 行，替代 Express |
| `src/lib/errors.js` | `HttpError` + 错误码映射 + 统一响应信封 | 5xx 只记日志不回堆栈 |
| `src/lib/crypto.js` | scrypt 密码、随机令牌、HMAC、恒定时间比较 | 无 bcrypt 依赖 |
| `src/lib/logger.js` | JSON Lines 日志、5MB×5 滚动、尾部读取 | 与站点的 nginx 日志分离 |
| `src/http/security.js` | 会话装载、IP 限流、CSRF、权限守卫、审计落盘 | 顺序：auth → rate → csrf → audit |
| `src/db/` | 连接、Pragma、迁移执行器、种子数据 | 迁移按 `NNN_*.sql` 单事务执行 |
| `src/services/sites.js` | 校验、唯一性、状态机、spec 组装、配置预览 | 纯业务，不执行系统命令 |
| `src/services/runtimes.js` | 环境目录、安装/卸载、默认版本、服务控制 | 卸载前检查站点引用 |
| `src/services/certs.js` | 证书状态机、巡检、续期调度、异常告警 | 供定时器与手动接口共用 |
| `src/services/tasks.js` | 队列、并发、事件流、取消、清理 | 同目标互斥；`running` 重启后置失败 |
| `src/services/handlers.js` | 任务编排（建站/应用/删除/证书/环境） | 失败必须 `last_error` + 告警 |
| `src/services/agent.js` | socket 客户端、签名、帧解析、超时 | 连接失败统一转 `AGENT_UNAVAILABLE` |
| `src/services/metrics.js` | 主机指标滑动窗口（5s × 180 点 = 15 分钟，仅内存） | 后台采样，前端轮询 `/system/metrics` 取当前值 + 历史 |
| `src/routes/*.js` | 按资源拆分的 REST 端点 | 路由只做校验/鉴权/审计，业务在 service |

### 3.2 agent

| 文件 | 职责 |
| --- | --- |
| `src/agent.js` | socket 服务、并发上限、验签、帧协议、优雅退出 |
| `src/lib/security.js` | 时间窗 + nonce + HMAC 校验 |
| `src/lib/exec.js` | `spawn` 执行器（超时、流式行输出、`ExecError`） |
| `src/lib/fs-safe.js` | 路径前缀校验、原子写、符号链接、尾部读、目录用量 |
| `src/lib/distro.js` | 发行版探测、apt 封装、PHP 源（ondrej / sury） |
| `src/lib/host-metrics.js` | `/proc/stat`、`/proc/meminfo`、`statfs`、`/proc/net/dev` 采样；CPU 与网卡为增量指标，内部 1s 差分后缓存 |
| `src/ops/system.js` | 探活、主机信息（含本机地址表）、实时指标、DNS 检查 |
| `src/ops/service.js` | systemd 单元白名单、状态、启停、`nginx -t` |
| `src/ops/runtime.js` | Nginx/PHP/MariaDB/Redis/Node 安装与基线配置 |
| `src/ops/site.js` | 站点用户/目录、vhost 与 pool 落盘、回滚、备份、日志读取 |
| `src/ops/cert.js` | certbot 签发/续期/吊销、证书上传与校验 |

### 3.3 shared

`shared/` 同时被 panel（预览）与 agent（落盘）引用，保证「页面看到的配置 = 实际写入的配置」。
渲染器是**纯函数**，输入受校验的 spec，输出字符串，可直接单测。

## 4. 请求生命周期

```
请求 → 路由匹配 → 解析 JSON（1MB 上限）
     → sessionLoader（Cookie → 会话 → 用户）
     → rateLimit（IP/分钟）
     → csrfGuard（Origin + 双提交令牌）
     → perm('...')（路由级权限）
     → handler（service）
     → 响应（成功 {ok,data} / 失败 {ok,error}）
     → auditFlusher（响应结束后写审计）
```

需要长时间执行的动作不会阻塞请求：handler 只做「校验 + 落库 + 入队」，返回 `202` 或 `201` 带 `task`，前端用 SSE 订阅任务事件。

## 5. 任务引擎

### 5.1 状态机

```
queued ──claim──▶ running ──成功──▶ success
   │                 │
   │                 ├──异常──▶ failed（记录 error）
   └──取消──────────▶ canceled（运行中取消通过 AbortController 传递）
```

- 任务与事件分别落 `tasks`、`task_events`，事件带自增 `seq`，前端断线重连可 `?after=<seq>` 续传。
- 并发由 `XFMP_TASK_CONCURRENCY` 控制（默认 2），避免同时安装多个组件抢占 apt 锁。
- **同目标互斥**：同一站点的任何变更类任务不允许并发；同一对象同类型任务入队时直接返回 `TASK_CONFLICT`（409）。
- **崩溃恢复**：启动时把遗留 `running` 任务标记为 `failed` 并写明原因，避免永远卡住。

### 5.2 handler 契约

```js
async function handler(ctx) {
  ctx.log('info', '...');        // 写入事件流并推送 SSE
  ctx.progress(45, '写配置');     // 更新 tasks.progress
  await callAgent('site.apply', { spec }, { signal: ctx.signal, onLog, onProgress });
  return { ... };                // 落 tasks.result
}
```

约束：失败必须抛出异常（由引擎统一收尾），并在此之前把业务对象置为 `error` 且写 `last_error`，同时 `alerts.raise()` 产生可确认的告警。

## 6. 配置生成与回滚

```
site 行 (DB) ──buildSpec──▶ spec ──renderSiteVhost──▶ vhost 文本
                                  └─renderPhpPool───▶ pool 文本
agent: 备份旧文件 → 原子写 → 软链 sites-enabled → nginx -t
        ├─ 通过 → reload nginx / php-fpm
        └─ 失败 → 恢复旧文件/软链 → 抛 NGINX_TEST_FAILED（nginx stderr 片段）
```

因此面板上的「配置预览」与磁盘内容始终一致，排障时无需登服务器比对。

## 7. 主机指标采集

首页的 CPU / 内存 / 磁盘 / 网络曲线走一条独立于任务引擎的短链路：

```
agent（root）                               panel（无 root）
/proc/stat /proc/meminfo          每秒采样
statfs("/") /proc/net/dev  ───────────────►  host-metrics.js  差值计算 → 最近 1 份快照
                                                    ▲
                                   system.metrics（socket + HMAC）
                                                    ▲
panel/src/services/metrics.js  每 5s 取一次 → 环形缓冲 180 点（15 分钟，仅内存）
                                                    ▲
GET /system/metrics（site:read）→ 前端 5s 轮询 → 手写 SVG 折线图
```

要点：

- **增量指标必须差分**：CPU 使用率与网卡速率是计数器差值，agent 内部固定 1s 采样并保存上一份读数，面板不需要自己维护时间窗；首次请求最多等 1.2s 建立基线。
- **读数不做信任边界外的加工**：面板只做百分比换算与滑动窗口，不读设备文件，也不执行 `top`/`df` 之类的命令（磁盘用 `statfs`，避免每秒 fork 进程）。
- **不落库**：曲线是瞬时观测，重启即清空；这样既避免每秒写盘，也不会让 SQLite 无限增长。需要长期趋势应接 Prometheus，而不是把面板当监控系统。
- **降级**：agent 离线时接口返回 `available:false` + 错误原因，前端展示空状态而不是画一条假曲线；agent 侧采样失败也只影响该 op，不影响其它操作。
- **权限**：复用 `site:read`，只读角色也能看主机负载；指标响应中不含文件路径、环境变量等敏感信息。

## 8. 错误处理分层

| 层 | 策略 | 对外表现 |
| --- | --- | --- |
| 输入校验 | `shared/validate.js` / `assert*` | `422 VALIDATION_FAILED` + `field` |
| 业务规则 | `HttpError('CONFLICT')` 等 | `409`，消息含具体原因（如"PHP 8.3 尚未安装"） |
| agent 通信 | 连接失败 / 超时 / 拒绝 | `503 AGENT_UNAVAILABLE` / `502 AGENT_REJECTED` |
| 任务执行 | 异常写 `tasks.error` + 事件流 + 告警 | 任务 `failed`，站点 `error` + `lastError` |
| 证书 | 签发/续期失败 | `certificates.status=failed` + `last_error` + 告警（续期失败为 critical） |
| 未捕获异常 | 进程级 handler + 请求级 try/catch | `500 INTERNAL`，堆栈仅入日志（带 requestId） |

前端统一在 `api.js` 解析错误信封，`401` 自动切登录页，其它错误以 toast 或表单内提示呈现。

## 9. 安全设计要点

| 风险 | 缓解 |
| --- | --- |
| 会话劫持 | 随机 256bit 令牌，DB 只存 sha256；HttpOnly + SameSite=Lax + 反代下 Secure；改密/禁用后吊销全部会话 |
| CSRF | 非安全方法必须带 `X-CSRF-Token`，且校验 `Origin/Referer` 与 Host 一致 |
| 暴力破解 | 三层：IP 限流、`login_throttle` 表（按 IP 与用户名）、用户级失败计数与锁定 |
| 命令注入 | agent 全部 argv 调用；包名、unit、域名、slug、路径均白名单 |
| 路径穿越 | 站点根目录强等于 `/www/xfm/<slug>`；删除前 `realpath` 复核 |
| 配置注入 | 不接受任意 nginx 片段，仅枚举伪静态；数值参数 clamp |
| 信息泄露 | 错误信封不含堆栈/路径；CSP 禁内联脚本；`server_tokens off` |
| 越权 | 路由级 `perm()`；owner 账号不可被降级/删除（保留最后一个） |
| 审计缺失 | 所有写操作 + 登录成功/失败都落 `audit_logs`，含 IP 与 UA |

## 10. 可维护性

- **零依赖**：无 `package-lock` 漂移、无原生模块、无 `npm audit` 噪音；升级 Node 即可。
- **同源渲染**：`shared/render/*` 是唯一配置来源，预览/落盘/单测共用。
- **迁移受控**：`panel/src/db/migrations/NNN_*.sql` 按序执行，单文件单事务，失败整体回滚。
- **结构化日志**：JSON Lines + `module`/`ctx` 字段，可直接被 Loki/ELK 采集。
- **可观测**：`/system/health`（探活）、`/system/overview`（聚合）、任务事件流（细粒度）。
- **可测试**：`tests/run.mjs` 在 stub agent 下跑完整业务链路，CI 无需 Linux 权限。

## 11. 扩展指引

新增一个 agent 能力（示例：切换 PHP 版本后重建 pool）：

1. 在 `shared/protocol.js` 的 `AGENT_OPS` 中登记 op；
2. 在 `agent/src/ops/<domain>.js` 实现 `{ validate, run }` 并加入 `ops/index.js`；
3. 在 `panel/src/services/*` 中调用 `callAgent('your.op', args)`；
4. 若是长任务，注册 handler 到 `services/handlers.js`，由 `createTask` 入队；
5. 路由层加 `perm()` 与 `ctx.audit()`；
6. 补 `tests/run.mjs` 断言。

新增配置项（例如 nginx 的 `client_body_timeout`）：只改 `shared/validate.js` 的白名单 + `shared/render/nginx.js` + 前端表单，agent 无需改动。
