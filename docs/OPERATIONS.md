# 运维手册

面向已经完成部署的 XFMPanel 实例，覆盖日常巡检、配置变更、证书与站点运维、备份恢复、容量治理和故障处置。

- 首次安装、TLS 反代与升级安装见 [DEPLOYMENT.md](DEPLOYMENT.md)
- 接口与错误码见 [API.md](API.md)，表结构见 [DATABASE.md](DATABASE.md)
- 本文命令默认以 `root` 执行；面板自身进程以 `xfmpanel` 用户运行

## 1. 运行拓扑

| 进程 | systemd 单元 | 用户 | 职责 |
| --- | --- | --- | --- |
| 面板 | `xfmpanel-panel.service` | `xfmpanel` | HTTP/API、SQLite、任务调度、证书巡检 |
| agent | `xfmpanel-agent.service` | `root` | 安装软件包、写 nginx/php 配置、签证书、删站点文件 |

两者的通信是 Unix Socket + HMAC-SHA256 签名，请求时间戳允许 ±30 秒偏差。面板依赖 agent 启动（`Requires=xfmpanel-agent.service`）。

| 路径 | 用途 |
| --- | --- |
| `/opt/xfmpanel` | 程序目录（升级时整体替换） |
| `/etc/xfmpanel/panel.env` | 环境配置（systemd 注入） |
| `/etc/xfmpanel/agent.secret` | 通信密钥（`0640 root:xfmpanel`） |
| `/var/lib/xfmpanel/xfmpanel.db` | SQLite 数据库（WAL 模式） |
| `/var/log/xfmpanel/panel.log` | 面板结构化日志 |
| `/var/log/xfmpanel/agent.log` | agent 日志 |
| `/var/log/xfmpanel/sites/<slug>/` | 站点 access/error/php-error 日志 |
| `/www/xfm/<slug>/public` | 站点代码根目录 |
| `/var/backups/xfmpanel/` | 站点删除时的自动备份 |
| `/etc/letsencrypt/live/xfm-<slug>/` | ACME 证书（certbot 管理） |
| `/etc/xfmpanel/certs/<slug>/` | 手动上传的证书与私钥 |
| `/run/xfmpanel/agent.sock` | agent socket（`srw-rw---- root xfmpanel`） |

## 2. 例行巡检

### 每日

```bash
# 1. 两个服务是否在运行
systemctl is-active xfmpanel-agent xfmpanel-panel

# 2. 健康检查：panel="ok"、agent.ok=true、db="ok"
curl -s http://127.0.0.1:8787/api/v1/system/health | jq '{panel, agent, db, uptimeSec}'

# 3. 最近是否出现新错误
journalctl -u xfmpanel-panel -u xfmpanel-agent --since today -p err --no-pager

# 4. 未确认告警数量：需登录会话 Cookie（浏览器开发者工具里取 xfm_sid）
#    curl -s -b 'xfm_sid=<session>' http://127.0.0.1:8787/api/v1/alerts/count
```

登录后重点看三处：概览页指标、告警中心、任务中心的 `failed` 任务。

### 每周

```bash
df -h / /var /www
du -sh /www/xfm/* /var/log/xfmpanel/* /var/backups/xfmpanel 2>/dev/null | sort -h | tail -20
systemctl status certbot.timer --no-pager
ls -lh /var/backups/xfmpanel | tail -10
```

- 证书剩余天数：界面「SSL 证书」或 `/api/v1/certificates`，剩余 ≤15 天会告警
- 备份数量是否符合保留策略，异常增长说明保留策略未生效或站点被频繁删除
- `journalctl` 中是否反复出现 `agent 调用失败`、`请求校验失败`

### 每月

- 抽查一条审计日志（登录、站点删除、证书上传、设置修改）
- 账号复核：离职/外包账号及时停用
- 做一次数据库恢复演练（在测试机，不要在生产上直接覆盖）
- 检查磁盘趋势与告警阈值是否需要调整

## 3. 服务管理

```bash
# 启动顺序由 systemd 依赖保证，直接一起启动即可
sudo systemctl start xfmpanel-agent xfmpanel-panel

# 只改环境配置后重启面板（agent 通常不需要动）
sudo systemctl restart xfmpanel-panel

# 停止（先停面板，避免它继续调用 agent）
sudo systemctl stop xfmpanel-panel xfmpanel-agent

# 开机自启
sudo systemctl enable xfmpanel-agent xfmpanel-panel

# 实时日志
journalctl -u xfmpanel-panel -f
tail -f /var/log/xfmpanel/panel.log
```

面板收到 `SIGTERM` 会优雅退出。**重启时所有 `running` 任务会被标记为 failed（结果未知）**，`queued` 任务保留继续执行。因此升级/重启尽量避开建站、装环境、签证书的高峰。

日志轮转由 `/etc/logrotate.d/xfmpanel` 负责（每日、保留 14 份、`copytruncate`），只覆盖 `/var/log/xfmpanel/*.log`。站点日志目录不在该通配范围内，若站点访问量大，建议追加：

```bash
sudo tee /etc/logrotate.d/xfmpanel-sites >/dev/null <<'EOF'
/var/log/xfmpanel/sites/*/*.log {
    daily
    rotate 14
    missingok
    notifempty
    delaycompress
    compress
    copytruncate
    su root xfmpanel
}
EOF
```

## 4. 配置变更

配置分两层，改错的影响范围不同：

| 层级 | 位置 | 生效方式 | 典型内容 |
| --- | --- | --- | --- |
| 环境变量 | `/etc/xfmpanel/panel.env` | 重启面板 | 监听地址、数据目录、agent socket、并发数、限流 |
| 业务设置 | 界面「系统设置」/ `settings` 表 | 立即或下一次任务/巡检生效 | 证书邮箱、自动续期、默认 PHP、保留天数、Webhook |

改环境变量前先备份：

```bash
sudo cp -a /etc/xfmpanel/panel.env /root/panel.env.$(date +%F-%H%M)
sudo vi /etc/xfmpanel/panel.env
sudo systemctl restart xfmpanel-panel
curl -s http://127.0.0.1:8787/api/v1/system/health | jq '.panel,.agent'
```

常用业务设置：

| 设置键 | 默认 | 生效点 |
| --- | --- | --- |
| `cert.email` | 空 | 下次申请/续期时传给 certbot |
| `cert.autoRenew` | `true` | 证书巡检入队前判断 |
| `cert.renewBeforeDays` | `30` | 巡检与自动续期阈值（7–60） |
| `security.sessionTtlHours` | `12` | 新建会话与滑动续期（1–168） |
| `security.loginMaxAttempts` | `5` | 登录限流阈值（1–20） |
| `ops.taskRetentionDays` | `30` | 任务与任务事件清理（1–365） |
| `ops.backupRetentionDays` | `30` | 备份文件与记录清理（1–3650） |
| `ops.backupBeforeDelete` | `true` | 删除站点时是否先打包 |
| `site.defaultAppType` / `defaultPhpVersion` / `defaultRewrite` | `php` / `8.3` / `none` | 新建站点未显式传参时 |
| `notify.webhookUrl` | 空 | 新告警产生时异步 POST |

设置值有类型与范围校验，非法值会被接口拒绝（422），不会写库。生产环境里 `XFMP_TRUST_PROXY` 只在面板确实位于可信反代之后时设为 `1`，否则伪造 `X-Forwarded-For` 可绕过限流并污染审计 IP。

## 5. 监控与告警

### 健康检查

`GET /api/v1/system/health` 无需登录，适合探活：

```json
{
  "panel": "ok",
  "agent": { "ok": true, "mode": "unix", "latencyMs": 1 },
  "db": "ok",
  "uptimeSec": 3600
}
```

`agent.ok=false` 时页面仍能打开，但所有变更操作都会失败，按第 12 节排查。

### 指标

- 概览页：CPU、内存、磁盘、网络、站点/证书/任务统计
- `GET /api/v1/system/metrics?refresh=1`：实时采样；不带参数返回缓存与最近 15 分钟历史

### 告警

告警在界面「告警中心」查看；接口需要登录会话：

```bash
curl -s -b 'xfm_sid=<session>' 'http://127.0.0.1:8787/api/v1/alerts?open=1'
```

同 `dedupe_key` 的未确认告警会被更新而不是重复插入；条件恢复后部分告警会自动关闭（如证书续期成功、站点配置应用成功）。处理完请在界面点击确认，避免掩盖下一次真实故障。

`notify.webhookUrl` 只在新告警产生时推送一次，5 秒超时，失败仅写面板日志，不阻塞任务。载荷示例：

```json
{
  "type": "alert",
  "alert": {
    "id": 12,
    "level": "critical",
    "source": "cert",
    "code": "CERT_EXPIRED",
    "title": "证书已过期：example.com",
    "message": "证书于 2026-11-01 过期，站点 HTTPS 将不可访问",
    "resource": "cert:3",
    "at": "2026-11-19T02:00:00.000Z"
  }
}
```

常见告警与处置：

| code | 含义 | 处置 |
| --- | --- | --- |
| `INSTALL_FAILED` | 运行时安装失败 | 看任务日志中的 apt/systemd 报错，处理锁或源后重试 |
| `CREATE_FAILED` | 建站失败 | 看 `nginx -t` 输出；旧配置已自动回滚 |
| `APPLY_FAILED` | 站点配置应用失败 | 修复域名/证书/上游后重新「应用配置」 |
| `CERT_ISSUE_FAILED` | 首次签发失败 | 检查 DNS、80 端口、webroot 权限 |
| `CERT_RENEW_FAILED` | 续期失败 | 同上，并确认未触发 Let's Encrypt 频率限制 |
| `CERT_EXPIRING` | 剩余天数 ≤15 | 确认自动续期为开；检查续期任务 |
| `CERT_EXPIRED` | 证书已过期 | 立即手动续期或更换证书，HTTPS 已不可用 |

## 6. 任务中心运维

- 所有耗时操作（装环境、建站、应用配置、证书、删除）都是任务；状态：`queued → running → success/failed/canceled`
- 并发数默认 2（`XFMP_TASK_CONCURRENCY`）；同一站点不允许并发变更类任务
- 只有 `queued` 任务可以取消；`running` 只能等结束。取消会回滚该任务的中间状态
- 任务事件落库（`task_events`），失败任务的日志尾部通常足够定位问题
- 历史任务按 `ops.taskRetentionDays` 清理，事件随任务一起删除
- 面板重启会把 `running` 任务置为失败，需人工确认后重新提交

处理失败任务的标准动作：

1. 打开任务详情，读最后一条 `error` 与日志尾部
2. 判断是环境问题（apt 锁、端口占用、DNS）还是配置问题（nginx -t、证书路径）
3. 修复后从原入口重试；不要直接改 nginx/php 落盘文件，下一次「应用配置」会覆盖

## 7. 证书运维

### 巡检与续期

- 启动后 30 秒做首次巡检，之后每 6 小时一次（`XFMP_CERT_CHECK_INTERVAL_MS`）
- `issued`/`expiring`/`expired` 状态按 `not_after` 校正；剩余 ≤`cert.renewBeforeDays` 进入 `expiring`
- 自动续期只处理 `auto_renew=1`、`provider=acme` 的证书；总开关为 `cert.autoRenew`
- 续期任务与签发、上传、吊销共用站点级互斥，避免并发改同一份 nginx 配置
- 手动续期默认不加 `--force-renewal`，由 certbot 判断是否真的需要签发；频繁强制会消耗 Let's Encrypt 配额

Let's Encrypt 限制（足够触发故障的几条）：

- 同一账号 + 同一域名，失败验证 5 次/小时
- 同一组域名重复签发 5 次/周
- 每个注册域名 50 张证书/周

失败后先排查再重试：`dig +short 域名`、`curl -I http://域名/.well-known/acme-challenge/test`、`tail -100 /var/log/letsencrypt/letsencrypt.log`。

### 手动上传证书

- 域名必须属于该站点（主域名或别名），且证书 SAN/CN 必须覆盖该域名
- 支持可选中间证书链；落盘为 `<domain>.crt`、`<domain>.key`、`<domain>.chain.crt`、`<domain>.fullchain.crt`
- 上传证书不参与自动续期，界面不提供「续期」按钮
- 吊销上传证书只更新面板状态并把站点回退到 HTTP，不会调用 certbot

### 常用动作

| 场景 | 操作 |
| --- | --- |
| 即将到期 | 确认自动续期为开，等待巡检入队；或手动「续期」 |
| 续期一直失败 | 先查 DNS/80 端口/webroot 权限，再查 LE 日志与频率限制 |
| 更换为商业证书 | 站点详情「上传证书」，填写证书、私钥、可选链 |
| 不再使用 HTTPS | 吊销证书；站点会回退到 HTTP |
| 更换域名 | 先改站点域名并应用配置，再重新签发证书 |

## 8. 站点运维

### 生命周期

| 操作 | 影响 |
| --- | --- |
| 停用 | 仅停 vhost/php pool，保留文件与数据库 |
| 启用 | 重新生成并加载配置 |
| 重载 | 按数据库当前状态重建 nginx/php 配置，不改代码 |
| 删除 | 删除配置、站点用户、数据库记录；默认先打包到 `/var/backups/xfmpanel/<slug>-<时间>.tar.gz` |

`ops.backupBeforeDelete=false` 时删除不打包。备份文件由清理任务按 `ops.backupRetentionDays` 删除，数据库记录随站点删除级联清除。

### 文件与权限

| 路径 | 属主/权限 | 说明 |
| --- | --- | --- |
| `/www/xfm/<slug>` | `xfm_<slug>:xfm_<slug>` | 站点根 |
| `/www/xfm/<slug>/public` | 同上 | Web 根目录，代码放这里 |
| `/www/xfm/<slug>/tmp` | 同上 | 临时目录 |
| `/www/xfm/<slug>/backup` | `0700` | 站点私有备份 |
| `/etc/nginx/sites-available/xfm-<slug>.conf` | root | 由面板生成，勿手改 |
| `/etc/php/<ver>/fpm/pool.d/xfm-<slug>.conf` | root | 由面板生成，勿手改 |
| `/run/php/xfm-<slug>.sock` | `www-data` | PHP-FPM socket |

排查站点问题：

```bash
tail -f /var/log/xfmpanel/sites/<slug>/error.log
tail -f /var/log/xfmpanel/sites/<slug>/php-error.log
systemctl status php8.3-fpm nginx --no-pager
ls -l /run/php/xfm-<slug>.sock
```

删除站点后如需找回代码，从 `/var/backups/xfmpanel/` 解包；注意保留期默认只有 30 天。

## 9. 备份与恢复

### 需要备份的内容

| 内容 | 频率 | 命令 |
| --- | --- | --- |
| 数据库 | 每日 | `sqlite3 /var/lib/xfmpanel/xfmpanel.db ".backup '/root/xfm-$(date +%F).db'"` |
| 配置与密钥 | 每周或变更后 | `tar czf /root/xfm-etc-$(date +%F).tar.gz /etc/xfmpanel` |
| 站点代码 | 按需 | `tar czf /root/xfm-sites-$(date +%F).tar.gz /www/xfm` |
| 备份目录 | 按需 | 异地同步 `/var/backups/xfmpanel` |

SQLite 处于 WAL 模式，**不要直接 `cp` 数据库文件**；用 `.backup` 或在停面板后复制 `.db`、`-wal`、`-shm` 三个文件。未安装 `sqlite3` 时先 `apt install -y sqlite3`。

### 恢复到本机/新机器

1. 安装同版本面板（新机器先完成 `install.sh`）
2. 停面板：`sudo systemctl stop xfmpanel-panel`（agent 可保持运行）
3. 覆盖数据库：删除旧的 `xfmpanel.db`、`-wal`、`-shm`，放入备份文件并确保属主为 `xfmpanel`
4. 覆盖 `/etc/xfmpanel/panel.env` 与 `agent.secret`，保持 `0640 root:xfmpanel`
5. 恢复 `/www/xfm`（站点代码与属主）
6. 启动面板：`sudo systemctl start xfmpanel-panel`
7. 在「站点管理」逐个点「重载」，重建 nginx/php 配置
8. 验证：健康检查、任意站点 HTTPS、证书剩余天数、任务中心无异常

若管理员密码未知，用本地重置脚本（会踢出该账号所有会话）：

```bash
cd /opt/xfmpanel
sudo npm run reset-admin -- --user admin --password 'NewPass1234'
```

## 10. 容量与数据保留

| 数据 | 默认保留 | 控制项 |
| --- | --- | --- |
| 任务与任务事件 | 30 天 | `ops.taskRetentionDays` |
| 证书巡检记录 | 90 天 | `XFMP_CERT_CHECK_RETENTION_DAYS` |
| 审计日志 | 180 天 | `XFMP_AUDIT_RETENTION_DAYS` |
| 站点备份 | 30 天 | `ops.backupRetentionDays` |
| 过期会话 | 过期后 24 小时 | 固定策略 |
| 登录限流记录 | 锁定期结束后清理；未锁定的 24 小时后清理 | 固定策略 |
| 面板/agent 日志 | 14 份日轮转 | `/etc/logrotate.d/xfmpanel` |

清理任务在面板启动后每 12 小时执行一次；**没有立即清理的入口**。修改保留天数后，最长需要等一个周期才生效。磁盘告急时可先手工处理备份与站点日志：

```bash
# 只删 30 天前的站点自动备份（清理任务之后会同步删除数据库记录）
sudo find /var/backups/xfmpanel -maxdepth 1 -type f -name '*.tar.gz' -mtime +30 -delete

# 站点日志轮转（确认 logrotate 配置后手动触发）
sudo logrotate -f /etc/logrotate.d/xfmpanel-sites
```

## 11. 安全运维

- 初始密码只使用一次，登录后立即修改，并删除 `/etc/xfmpanel/initial-admin.txt`
- 确认 `panel.env` 中的 `XFMP_ADMIN_PASSWORD` 已清空
- 角色：`owner`（全部权限）、`admin`（站点/运行时/证书管理，不能删站点或改设置）、`operator`（站点与证书日常操作，不能删除站点）、`viewer`（只读）；不要共用 `owner`
- 推荐面板只监听 `127.0.0.1`，公网访问经 nginx + TLS；反代时 `XFMP_TRUST_PROXY=1`，直连时必须为 `0`
- 会话默认 12 小时滑动过期；修改 TTL 后新会话按新值，已签发 Cookie 到期后重新登录
- 登录失败按 IP 与 IP+用户名联合计数，达到阈值锁定 15 分钟；这是为了防暴力破解，不提供永久锁死账号的机制
- agent 密钥权限必须为 `0640 root:xfmpanel`；泄露后立即轮换

轮换 agent 密钥（会使进行中任务失败）：

```bash
sudo systemctl stop xfmpanel-panel xfmpanel-agent
sudo sh -c 'head -c 32 /dev/urandom | base64 > /etc/xfmpanel/agent.secret'
sudo chown root:xfmpanel /etc/xfmpanel/agent.secret
sudo chmod 0640 /etc/xfmpanel/agent.secret
sudo systemctl start xfmpanel-agent xfmpanel-panel
curl -s http://127.0.0.1:8787/api/v1/system/health | jq .agent
```

审计日志在界面「日志审计」查看，重点事件：登录失败、用户/权限变更、站点删除、证书上传/吊销、设置修改。建议每月抽查并留存关键记录。

## 12. 故障处置

| 现象 | 定位 | 处置 |
| --- | --- | --- |
| 页面能开但操作全失败，`agent.ok=false` | `systemctl status xfmpanel-agent`；socket 是否存在、权限是否正确 | 启动 agent；`ls -l /run/xfmpanel/agent.sock` 应为 `srw-rw---- root xfmpanel` |
| agent 日志「请求校验失败」 | 两侧读取的密钥不一致 | 核对 `/etc/xfmpanel/agent.secret` 权限与 `panel.env` 中的路径；轮换密钥 |
| 时间戳超出允许范围 | 系统时钟漂移超过 ±30 秒 | `timedatectl status`，启用/重启 `systemd-timesyncd` |
| 任务长时间 `queued` | 并发占满（默认 2）或同站点存在未完成任务 | 等前序任务结束；必要时取消 `queued` 任务 |
| 任务一直 `running` 但无日志 | agent 卡在 apt/nginx 命令 | 看 agent 日志与 `ps`；重启面板会将其标记为失败，再重试 |
| 建站/重载失败 | 任务日志中的 `nginx -t` 输出 | 旧配置已自动回滚；修复后重新应用 |
| 磁盘满 | `du -sh /www/xfm/* /var/log/xfmpanel/* /var/backups/xfmpanel` | 清理过期备份/日志；调小保留天数；扩容 |
| 数据库 `busy`/`locked` | 是否有两个面板进程或外部 sqlite 写入 | 只保留一个面板实例；停止外部写入；检查 `journalctl` |
| 续期失败并提示频率限制 | `/var/log/letsencrypt/letsencrypt.log` | 停止重试，修复 DNS/80 端口/webroot 后等待配额窗口 |
| 站点 403/500 | 站点 `error.log`、`php-error.log` | 检查入口文件、`open_basedir`、PHP-FPM 是否运行 |
| 登录 423/429 | 触发失败阈值/请求限流 | 等 15 分钟；直连部署确认 `XFMP_TRUST_PROXY=0`；紧急用 `reset-admin` |
| 忘记密码且无法登录 | 面板进程正常 | SSH 上执行 `npm run reset-admin`，会同时踢出该账号会话 |

### 应急恢复顺序

1. 确认 agent 与面板进程状态
2. `curl` 健康检查，区分「面板不可用」与「agent 不可用」
3. 看 `journalctl -u xfmpanel-panel -n 200` 与 `panel.log` 最后 100 行
4. 需要回滚时先备份数据库，再按第 13 节操作
5. 恢复后在任务中心重新提交失败的操作，并核对站点 HTTPS 与证书状态

## 13. 升级与回滚

升级前的检查：

- [ ] 阅读 `CHANGELOG.md` 中的破坏性变更与迁移说明
- [ ] 备份数据库、`/etc/xfmpanel`、`/www/xfm`
- [ ] 确认磁盘余量足够容纳新版本与数据库增长
- [ ] 选择低峰窗口：重启会让 `running` 任务失败
- [ ] 记录当前版本与提交号，便于回滚

升级命令见 [DEPLOYMENT.md](DEPLOYMENT.md) 第 7 节。升级后：

```bash
systemctl status xfmpanel-agent xfmpanel-panel
curl -s http://127.0.0.1:8787/api/v1/system/health | jq
curl -s http://127.0.0.1:8787/api/v1/system/overview -H 'Cookie: ...' | jq '.panel.version'
```

> **不要在生产环境执行 `npm test`**：端到端测试会创建、修改并删除真实站点。

回滚：`git checkout <旧版本> && sudo ./deploy/install.sh`。数据库迁移只向前，若新版本已改写 schema，需同时恢复升级前的数据库备份。

## 14. 应急速查

```bash
# 服务状态与重启
systemctl status xfmpanel-agent xfmpanel-panel --no-pager
sudo systemctl restart xfmpanel-agent xfmpanel-panel

# 健康检查
curl -s http://127.0.0.1:8787/api/v1/system/health | jq

# agent 日志
journalctl -u xfmpanel-agent -n 200 --no-pager
tail -200 /var/log/xfmpanel/agent.log

# 面板日志
journalctl -u xfmpanel-panel -n 200 --no-pager
tail -200 /var/log/xfmpanel/panel.log

# 数据库安全备份
sqlite3 /var/lib/xfmpanel/xfmpanel.db ".backup '/root/xfm-$(date +%F-%H%M).db'"

# 重置管理员密码（同时踢出会话）
cd /opt/xfmpanel && sudo npm run reset-admin -- --user admin --password 'NewPass1234'

# 列出账号
cd /opt/xfmpanel && sudo npm run reset-admin -- --list

# 证书到期检查
for d in /etc/letsencrypt/live/*/cert.pem; do
  openssl x509 -enddate -noout -in "$d" | sed "s|^|$d |"
done
```

## 15. 变更与事故记录

建议每次变更/事故保留一条记录，至少包含：

| 字段 | 内容 |
| --- | --- |
| 时间 | 开始、恢复时间（含时区） |
| 影响 | 站点/证书/面板，是否 HTTPS 中断 |
| 现象 | 告警 code、任务 ID、错误原文 |
| 定位 | 关键日志片段与命令 |
| 处置 | 实际执行的步骤与结果 |
| 后续 | 待办、监控项、是否需要调整保留策略或限流阈值 |
