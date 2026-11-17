# 部署与运维

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | Debian 12 / Ubuntu 22.04+（x86_64 或 arm64），systemd |
| 权限 | root（安装 agent 与系统包） |
| 资源 | 最低 1 核 / 1GB（仅面板）；跑站点建议 2 核 / 2GB 起 |
| 网络 | 能访问软件源、`deb.nodesource.com`、Let's Encrypt（签发证书） |
| 端口 | 80/443 对外；8787 在反代模式下仅本机、直连模式下对外；22 用于运维 |

> 面板自身不依赖 Docker、不依赖 Python；全部运行时就是一个 Node 进程 + 一个 root agent 进程。

## 2. 安装

### 2.1 全新 VPS（单文件安装，不必先克隆）

SSH 登录后直接跑，脚本自己拉源码：

```bash
wget -qO install.sh https://raw.githubusercontent.com/xfm0797/xfmpanel/main/deploy/install.sh
sudo bash install.sh
```

带域名与反代：

```bash
sudo bash install.sh --proxy-domain panel.example.com --public-url https://panel.example.com
```

管道方式（参数写在 `-s --` 后面）：

```bash
curl -fsSL https://raw.githubusercontent.com/xfm0797/xfmpanel/main/deploy/install.sh \
  | sudo bash -s -- --proxy-domain panel.example.com
```

> 用 `wget` 先落盘再执行比管道更稳：apt 步骤若意外读 stdin，管道模式下 stdin 就是脚本本身。URL 中的 `main` 为分支名，按仓库实际情况替换（`master` 等）。
>
> 仓库为 **私有** 时 `raw.githubusercontent.com` 需要 token，不能匿名 `wget`。此时二选一：把 `install.sh` 放到自己的静态站点（如 `https://你的域名/install.sh`）后照常 `wget`；或直接 `scp` 到 VPS 再 `sudo bash install.sh --from <git 地址或 tar 包>`。

### 2.2 源码来源（`--from`）

脚本优先使用本地源码（脚本所在目录或其上一级的 `package.json`），没有才下载。默认 `xfm0797/xfmpanel@main`，可替换：

```bash
sudo bash install.sh --from xfm0797/xfmpanel@v1.0.2                      # 锁版本（tag/branch）
sudo bash install.sh --from https://github.com/me/xfmpanel.git           # 其它仓库
sudo bash install.sh --from https://<token>@github.com/me/xfmpanel.git   # 私有仓库
sudo bash install.sh --from https://example.com/xfmpanel.tar.gz          # tar 包（.tar.gz/.tgz/.tar.xz）
sudo bash install.sh --from /root/xfmpanel.tar.gz                        # 已上传的包
sudo bash install.sh --from /root/xfmpanel                               # 已 scp 的目录
```

| 行为 | 说明 |
| --- | --- |
| 私有仓库/不可达 | `GIT_TERMINAL_PROMPT=0`，不会卡在账号密码提示；失败后打印 git 原始错误与替代方案 |
| 超时 | clone/下载默认 180s（`XFMP_FETCH_TIMEOUT=300` 可放宽），curl 下载 `--max-time 300` |
| 临时目录 | `/tmp/xfmpanel-src.XXXXXX`，安装结束自动清理；`--keep-src` 保留 |
| 内网离线 | `tar czf xfmpanel.tar.gz --exclude data --exclude .git .` 后 `scp`，用 `--from` 指过去 |

### 2.3 已克隆仓库

```bash
git clone https://github.com/xfm0797/xfmpanel.git
cd xfmpanel
sudo ./deploy/install.sh
```

### 2.4 地址自动探测（IPv4 / IPv6）

安装脚本会自己找出这台 VPS 的访问地址，不用手工查 `ip addr`：

```bash
sudo ./deploy/install.sh                 # 自动探测
sudo ./deploy/install.sh --prefer-ipv6   # 优先用 IPv6 作为对外地址
sudo ./deploy/install.sh --public-ip 203.0.113.10   # 手工指定（云厂商 NAT 场景）
sudo ./deploy/install.sh --no-detect     # 关闭探测，保持 127.0.0.1
```

| 步骤 | 说明 |
| --- | --- |
| 公网 IPv4 | 依次请求 `api.ipify.org` → `ipv4.icanhazip.com` → `ipv4.ident.me` → `ifconfig.me/ip`（单个失败自动换下一个） |
| 公网 IPv6 | 依次请求 `api64.ipify.org` → `ipv6.icanhazip.com` → `v6.ident.me` |
| 兜底 | 全部外网请求失败时读默认路由出口地址（`ip route get`），NAT 型 VPS 会拿到内网 IP 并给出提示 |
| 监听地址 | 未指定 `--proxy-domain` 且未显式 `--bind` 时自动设为 `0.0.0.0`，否则保持 `127.0.0.1` |
| 写入配置 | `XFMP_PUBLIC_URL` / `XFMP_PUBLIC_IPV4` / `XFMP_PUBLIC_IPV6`，概览页"访问地址"直接读取 |

安装结束会打印 IPv4 / IPv6 / 本机三个入口；若检测到 `0.0.0.0` 直连公网，还会提示改用 nginx + TLS。
升级时（`panel.env` 已存在）只补写缺失的地址键，并把仍是 `http://127.0.0.1:8787` 的占位 `XFMP_PUBLIC_URL` 纠正为探测结果，不覆盖人工改过的值。

> 防火墙不会被脚本自动修改：若检测到 `ufw` / `firewalld` 处于启用状态，会打印需要放行的端口；云厂商安全组需在控制台自行放行。

脚本行为（幂等，可重复执行用于升级）：

| 步骤 | 结果 |
| --- | --- |
| 地址探测 | 自动识别公网 IPv4 / IPv6，计算对外访问地址并决定监听地址（见 2.1） |
| 检查 Node ≥ 22 | 不足则用 NodeSource 安装（`--skip-node` 可跳过） |
| 创建用户 | `xfmpanel`（系统用户，nologin） |
| 创建目录 | `/opt/xfmpanel`、`/etc/xfmpanel`、`/var/lib/xfmpanel`、`/var/log/xfmpanel`、`/www/xfm`、`/var/backups/xfmpanel` |
| 生成密钥 | `/etc/xfmpanel/agent.secret`（`0640 root:xfmpanel`，仅首次） |
| 生成配置 | `/etc/xfmpanel/panel.env`（仅首次；已存在则保留） |
| 生成账号 | 首次安装写入 `/etc/xfmpanel/initial-admin.txt`（`0600`） |
| systemd | `xfmpanel-agent.service` + `xfmpanel-panel.service`，开机自启 |
| 健康检查 | `curl 127.0.0.1:8787/api/v1/system/health` |

安装完成后：

```bash
systemctl status xfmpanel-agent xfmpanel-panel
cat /etc/xfmpanel/initial-admin.txt
curl -s http://127.0.0.1:8787/api/v1/system/health | jq
```

## 3. 配置

配置文件：`/etc/xfmpanel/panel.env`（由 systemd 注入）。完整可选项见 `deploy/env.example`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XFMP_BIND` / `XFMP_PORT` | `127.0.0.1` / `8787` | 有反代时保持回环；无域名直连时安装脚本会设为 `0.0.0.0` |
| `XFMP_PUBLIC_URL` | | 对外地址，用于通知链接与概览展示 |
| `XFMP_PUBLIC_IPV4` / `XFMP_PUBLIC_IPV6` | 安装时探测 | 概览页"访问地址"显示用（IPv6 不带方括号） |
| `XFMP_DATA_DIR` / `XFMP_DB` | `/var/lib/xfmpanel` | 数据与数据库 |
| `XFMP_AGENT_MODE` | `unix` | **生产必须为 `unix`**；`stub` 仅供开发 |
| `XFMP_COOKIE_SECURE` | `auto` | 反代下自动按 `X-Forwarded-Proto` 加 Secure |
| `XFMP_TRUST_PROXY` | `1` | 信任 `X-Forwarded-For`（必须在反代后面才开） |
| `XFMP_SESSION_TTL_HOURS` | `12` | 会话滑动过期 |
| `XFMP_LOGIN_MAX_ATTEMPTS` | `5` | 触发锁定前的失败次数 |
| `XFMP_TASK_CONCURRENCY` | `2` | 同时执行的任务数 |
| `XFMP_CERT_RENEW_DAYS` | `30` | 提前续期天数（也可在界面改） |

修改后：

```bash
sudo systemctl restart xfmpanel-panel
```

## 4. 对外暴露：nginx + TLS

```bash
sudo apt install -y nginx certbot
sudo mkdir -p /var/www/letsencrypt

# 先用 webroot 方式签面板域名证书
sudo certbot certonly --webroot -w /var/www/letsencrypt -d panel.example.com

# 安装反代配置
sudo sed 's/panel.example.com/你的域名/g' deploy/nginx/xfmpanel.conf \
  | sudo tee /etc/nginx/sites-available/xfmpanel.conf
sudo ln -sf /etc/nginx/sites-available/xfmpanel.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

反代配置的三个关键点（`deploy/nginx/xfmpanel.conf` 已包含）：

1. `proxy_buffering off` 只对 `/api/v1/tasks/<id>/events` 生效——否则任务日志会攒到最后一次性吐出；
2. `client_max_body_size 8m`——面板不需要大文件上传，收紧以防内存放大；
3. `Strict-Transport-Security` + 只监听 443——避免会话 Cookie 走明文。

> 面板自带的「SSL 证书」功能管理的是**业务站点**证书，不管理面板自身的证书。面板证书建议用 certbot 系统级续期（`systemctl enable certbot.timer`）。

## 5. 防火墙与访问控制

```bash
# 只放行必要端口
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
# 反代模式（--proxy-domain）：8787 不要开放，面板只监听 127.0.0.1，公网无法直连
# 直连模式（无域名）：需要放行面板端口，并强烈建议用 `ufw allow from <你的IP> to any port 8787`
```

进一步收紧（强烈建议）：

```nginx
# /etc/nginx/sites-available/xfmpanel.conf 的 443 server 内
allow 203.0.113.0/24;   # 办公网 / 跳板机
allow 10.0.0.0/8;
deny all;
```

或改用 WireGuard / SSH 隧道访问：

```bash
ssh -L 8787:127.0.0.1:8787 root@your-vps
# 本地访问 http://127.0.0.1:8787
```

## 6. 首次使用流程

1. 登录 → 右上角头像 → 修改密码（初始密码只应使用一次）
2. 「网站环境」→ 安装 Nginx → 安装 PHP（如 8.3）
3. 「系统设置」→ 填写 ACME 邮箱、确认自动续期为开
4. 「站点管理」→ 新建站点（勾选自动申请证书）
5. 任务中心观察安装/建站/签发进度；失败时展开任务日志看具体命令输出
6. 业务站点上线：把代码放到 `/www/xfm/<slug>/public`

## 7. 升级

```bash
# 方式一：服务器上没有仓库（单文件安装过的），重跑安装脚本即可
wget -qO install.sh https://raw.githubusercontent.com/xfm0797/xfmpanel/main/deploy/install.sh
sudo bash install.sh --from xfm0797/xfmpanel@v1.1.0    # 不写 --from 则跟 main

# 方式二：有仓库
cd /path/to/xfmpanel && git pull
sudo ./deploy/install.sh          # 只替换代码与单元文件，保留 env/密钥/数据库
```

- 数据库迁移在启动时自动执行（单文件单事务）；
- 若新版本引入不兼容 schema 变更，会在日志中明确报错并拒绝启动，此时按 CHANGELOG 指引回滚备份；
- 回滚：`git checkout <旧版本> && sudo ./deploy/install.sh`。

## 8. 备份

```bash
# 面板数据库（WAL 安全备份）
sqlite3 /var/lib/xfmpanel/xfmpanel.db ".backup '/root/xfm-$(date +%F).db'"

# 配置与密钥
tar czf /root/xfm-etc-$(date +%F).tar.gz /etc/xfmpanel

# 站点（面板删除站点时会自动备份到 /var/backups/xfmpanel/）
tar czf /root/sites-$(date +%F).tar.gz /www/xfm
```

恢复到新机器：

1. 安装同版本面板；
2. 停 `xfmpanel-panel`；
3. 覆盖 `xfmpanel.db`、`/etc/xfmpanel/{panel.env,agent.secret}`；
4. 启动面板 → 到「站点管理」逐个执行「重载」以重建 nginx/php 配置。

## 9. 排障

| 现象 | 排查顺序 |
| --- | --- |
| 页面能开但所有操作报「系统代理不可用」 | `systemctl status xfmpanel-agent` → `journalctl -u xfmpanel-agent -n 100` → 检查 `/run/xfmpanel/agent.sock` 是否存在、`ls -l` 是否为 `srw-rw---- root xfmpanel` |
| agent 日志「请求校验失败」 | 两侧密钥不一致：`md5sum /etc/xfmpanel/agent.secret`，确认 `/etc/xfmpanel/panel.env` 指向同一文件且权限 `0640 root:xfmpanel` |
| 安装任务失败「apt lock」 | 有其它 apt 进程在跑：`fuser /var/lib/dpkg/lock-frontend`，等待或 `systemctl stop unattended-upgrades` |
| 建站失败「nginx 配置校验失败」 | 任务日志里有 `nginx -t` 的 stderr；旧配置已自动回滚，修复后重新「应用配置」即可 |
| 502 但面板进程活着 | nginx 侧超时/缓冲：检查 `proxy_read_timeout`，SSE 必须 `proxy_buffering off` |
| 证书签发失败「DNS 未生效」 | `dig +short 域名` 是否指向本机公网 IP；安全组/防火墙是否放行 80；`curl -I http://<域名>/.well-known/acme-challenge/test` |
| 证书续期一直失败 | 检查 `/var/log/letsencrypt/letsencrypt.log`；确认 webroot 目录属于 `www-data` 且 nginx 能读；确认未触发 LE 频率限制（同一域名每周 5 次失败上限） |
| 站点 403 / 500 | `tail -f /var/log/xfmpanel/sites/<slug>/error.log`；PHP 错误在 `php-error.log`；确认 `open_basedir` 未挡住程序需要的目录 |
| PHP 站点下载源码而不是执行 | 确认站点 `appType=php` 且对应 `phpX.Y-fpm` 正在运行；`ls -l /run/php/xfm-<slug>.sock` |
| 磁盘涨得快 | `du -sh /www/xfm/* /var/log/xfmpanel/* /var/backups/xfmpanel`；在设置里调小 `taskRetentionDays`；给站点加 logrotate |
| 忘记密码 | `cd /opt/xfmpanel && sudo npm run reset-admin -- --password 'NewPass1234'` |

日志位置：

| 日志 | 路径 |
| --- | --- |
| 面板（结构化） | `/var/log/xfmpanel/panel.log`（界面「日志审计」可读） |
| agent | `/var/log/xfmpanel/agent.log` + `journalctl -u xfmpanel-agent` |
| 站点 | `/var/log/xfmpanel/sites/<slug>/{access,error,php-error}.log` |
| 任务 | 界面任务详情（落库 `task_events`） |
| systemd | `journalctl -u xfmpanel-panel -f` |

## 10. 卸载

```bash
sudo ./deploy/uninstall.sh                # 停服务、删单元与代码，保留数据/站点
sudo ./deploy/uninstall.sh --purge        # 再删数据库/配置/日志/运行用户
sudo ./deploy/uninstall.sh --purge --purge-sites   # 连 /www/xfm 一起删（危险）
```

## 11. 本地开发模式

```bash
npm run dev
```

- 自动 `XFMP_ENV=dev` + stub agent，不需要 Linux/root；
- 数据落在 `./data`，可随时删除重来；
- stub 会模拟安装进度、证书签发（域名含 `fail` 时模拟失败），用于验证前端与错误提示；
- 端到端测试：`npm test`（35 项断言）。

## 12. 上线检查清单

- [ ] 面板只监听 `127.0.0.1`，公网访问必须经 nginx + TLS
- [ ] 修改初始密码，删除 `/etc/xfmpanel/initial-admin.txt` 与 `panel.env` 中的 `XFMP_ADMIN_PASSWORD`
- [ ] 配置 ACME 邮箱，确认「自动续期」开启
- [ ] 面板域名开启 HSTS，限制来源 IP 或使用 VPN
- [ ] `certbot.timer` 已启用（面板自身证书）
- [ ] 备份策略：数据库每日、`/etc/xfmpanel` 每周、站点按需
- [ ] 检查 `/var/log/xfmpanel` 已纳入 logrotate
- [ ] 为团队分配 `operator` 角色而非共用 `owner`
- [ ] 定期查看「告警中心」与「操作审计」
