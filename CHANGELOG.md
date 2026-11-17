# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
