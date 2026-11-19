# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-11-19

在 1.0.0 基础上修复了实机部署踩到的兼容性与状态机问题，并补齐小内存机型适配、
数据保留策略与运维手册。升级方式与 1.0.0 相同，重跑 `install.sh` 即可（会保留配置与数据）。

### 新增

**小内存机型适配**
- 内存 ≤1G 自动启用低内存配置（任务并发 1、PHP 进程池与 memory_limit 收紧），
  并可按需创建 1024MB swap + `vm.swappiness=10` 防 OOM
- 安装脚本新增 `--low-memory` / `--no-low-memory` / `--no-swap`，升级时只补缺省值、不覆盖用户显式配置
- 新增 `XFMP_LOW_MEMORY` 配置项

**备份与数据保留**
- 新增 `site.backup.prune` 运维指令与备份清理任务，按 `XFMP_BACKUP_RETENTION_DAYS`（默认 30 天）
  清理磁盘备份并同步删除 `backups` 记录
- 新增保留策略配置：`XFMP_CERT_CHECK_RETENTION_DAYS`（90 天）、`XFMP_AUDIT_RETENTION_DAYS`（180 天），
  定期清理证书巡检记录、审计日志、登录限流记录与失去宿主的孤立任务事件

**证书**
- 上传证书支持中间证书链（`chainPem`），解决部分 CA 签发证书在浏览器中链不完整的问题
- 部署前校验证书 SAN / CN 是否覆盖目标域名，不匹配时明确报错而非静默上线

**文档**
- 新增 [docs/OPERATIONS.md](docs/OPERATIONS.md) 运维手册：例行巡检、配置变更、证书与站点运维、
  容量治理、安全运维、故障处置、升级回滚、应急速查

### 修复

- **nginx 兼容性**：SSL vhost 由 `http2 on;` 改为 `listen 443 ssl http2`。`http2` 指令自 1.25.1 才引入，
  Debian 12（1.22）与 Ubuntu 22.04（1.18）系统源版本执行 `nginx -t` 会直接失败，导致证书签发后站点不可用
- **状态机原子性**：证书申请、站点创建/删除的状态变更与任务入队放入同一事务，任务冲突时一并回滚，
  避免对象永久停留在 `pending` / `deleting`
- **证书任务互斥**：同一站点的签发、续期、吊销、上传任务互斥，避免并发改写同一份证书与 vhost
- **Let's Encrypt 频率限制**：自动巡检续期不再附加 `--force-renewal`，仅在临近到期时真正续期
- **手动证书续期**：上传证书不再进入 certbot 续期流程（必然失败），改为明确提示重新上传；
  上传域名必须属于该站点
- **登录限流防误锁**：不再按用户名全局计数，改为「IP」与「IP+用户名」两个维度，并对连续失败施加渐进延迟。
  原策略下攻击者可用少量错误密码把管理员账号硬锁 15 分钟（拒绝服务）
- **会话有效期**：登录 Cookie 的 `maxAge` 跟随 `sessionTtlHours` 配置，不再写死
- **站点列表重复行**：一个站点持有多张证书时，改用相关子查询取最新一张，避免 JOIN 产生重复站点
- **任务取消语义**：只允许取消尚未开始的任务（运行中的 apt / certbot 不可安全中断），取消后回滚对象状态
- **中文域名**：IDN 统一转为 punycode 后再交给 nginx / certbot，避免非 ASCII 域名写入配置失败
- **备份清理安全**：只处理备份目录顶层的普通备份文件，不跟随符号链接、不递归

### 变更

- `XFMP_TRUST_PROXY` 默认值由 `1` 改为 `0`。直连部署下若信任 `X-Forwarded-For`，
  客户端可伪造来源 IP 绕过限流并污染审计日志；仅在面板确实位于可信反代之后时才开启
  （反代模式安装脚本会自动写入 `1`）

## [1.0.0] - 2026-11-17

首个正式版本：在 VPS 上用 Web 界面完成网站环境安装、站点全生命周期管理、
SSL 证书签发续期，并保留完整审计与运行日志。零第三方依赖（仅需 Node.js 22）。

### 新增

**网站环境**
- 环境一键安装与版本管理：Nginx、PHP（多版本 FPM）、MariaDB、Redis，任务化执行并实时推送进度
- 参数配置与状态管理：启动 / 停止 / 重载 / 查看状态与版本
- 安装源自适应：Debian 用系统源、Ubuntu 用 ondrej/sury PHP 源；不支持的发行版明确报错而非静默失败

**站点管理**
- 创建 / 修改 / 启停 / 重载 / 删除，支持 PHP、静态、反向代理三种站点类型
- 每站点独立系统用户（nologin）+ 独立 FPM pool，`open_basedir` 锁定站点目录，禁用 `exec` 等危险函数
- 伪静态预设（WordPress / Laravel / ThinkPHP 等）与 nginx 配置在线预览，预览与落盘同源
- 域名与别名冲突检测，配置写入失败自动回滚上一版 vhost

**SSL 证书**
- Let's Encrypt 自动申请（HTTP-01 webroot）、部署、到期前自动续期
- 证书上传与手动替换，到期提醒与异常告警
- 续期调度器定期巡检，失败重试并记录原因

**面板与运维**
- 登录、会话、CSRF 双提交校验、RBAC（admin / operator / viewer）、登录限流、全量操作审计
- 任务中心：异步队列、并发上限、同站点变更互斥、SSE 实时日志（带 seq 断线续传）
- 首页 VPS 实时状态：CPU / 内存 / 磁盘 / 网络四张曲线（agent 侧每秒采样、面板 15 分钟环形缓冲，不落库）
- 日志查看：面板日志、站点访问/错误日志、环境服务日志
- 告警中心与系统设置（ACME 邮箱、证书续期窗口等）

**安装与部署**
- `deploy/install.sh` 单文件自举安装：无需先克隆仓库，自动拉取源码并支持 `--from` 指定仓库 / tag / tar 包
- 安装地址自适应：自动探测公网 IPv4 / IPv6，无域名时监听 `0.0.0.0` 并打印可用登录地址
- systemd 双单元：面板以 `xfmpanel` 用户运行（无 root），特权操作交给 root 的 `xfmpanel-agent`
- nginx 反代 + TLS 模板、logrotate 策略、幂等升级与卸载脚本

### 安全

- 面板与 agent 通过 unix socket 通信，每请求 HMAC-SHA256 签名 + 时间窗 + nonce 防重放
- agent 侧 op 白名单 + 参数二次校验，命令一律 `execFile(argv)` 执行，永不过 shell
- 密码使用 scrypt 加盐哈希，Cookie 支持 Secure/HttpOnly/SameSite 与反代协议识别
- 站点目录严格限定在 `/www/xfm/<slug>`，路径穿越与符号链接逃逸均被拒绝

### 测试

- `npm test`：37 项端到端断言（登录限流、CSRF 拒绝、环境安装、建站含自动签发、
  启停、证书续期、坏配置失败落 `lastError`、指标接口、审计、删除）
- 开发模式内置 stub agent，Win/macOS/Linux 均可本地联调，不触碰真实系统

### 已知限制

- 自动安装仅覆盖 Debian 12 / Ubuntu 22.04+（RHEL 系会明确报错）
- `node:sqlite` 在 Node 22 仍标记 experimental（API 稳定，systemd 单元已关闭该警告）
- 指标数据仅保存在内存，重启清空；需要长期趋势请接 Prometheus

### 安装

```bash
wget -qO install.sh https://raw.githubusercontent.com/xfm0797/xfmpanel/main/deploy/install.sh
sudo bash install.sh --proxy-domain panel.example.com
```

国内网络可换 CDN：`https://cdn.jsdelivr.net/gh/xfm0797/xfmpanel@v1.0.0/deploy/install.sh`

[1.0.0]: https://github.com/xfm0797/xfmpanel/releases/tag/v1.0.0
