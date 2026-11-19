#!/usr/bin/env bash
# =============================================================================
# XFMPanel 安装 / 升级脚本（Debian 12 / Ubuntu 22.04+）
#
#   sudo ./deploy/install.sh                          # 安装或升级（保留配置与数据）
#   sudo ./deploy/install.sh --port 8788              # 自定义监听端口
#   sudo ./deploy/install.sh --proxy-domain panel.example.com   # 生成 nginx 反代配置
#
# 全新 VPS 不必先克隆仓库 —— 脚本会自己拉源码（单文件自举）：
#   wget -qO- https://raw.githubusercontent.com/xfm0797/xfmpanel/main/deploy/install.sh | sudo bash
#   wget -qO- https://cdn.jsdelivr.net/gh/xfm0797/xfmpanel@main/deploy/install.sh | sudo bash   # 国内网络
#   curl -fsSL .../install.sh | sudo bash -s -- --proxy-domain panel.example.com
#   sudo bash install.sh --from https://github.com/xfm0797/xfmpanel.git   # 指定其它仓库/压缩包
#
# 地址探测（默认开启，安装完成后直接给出可用的 IPv4 / IPv6 登录地址）：
#   * 优先探测公网地址，失败时退回默认路由出口地址（NAT / 内网 VPS）；
#   * 未指定 --proxy-domain 时自动监听 0.0.0.0，保证公网地址能直接访问；
#   * 可用 --public-ip、--prefer-ipv6、--no-detect 干预。
#
# 设计原则：
#   * 幂等：重复执行只更新代码与单元文件，不覆盖已有 panel.env / 密钥 / 数据库；
#   * 最小暴露：指定 --proxy-domain 时面板只监听 127.0.0.1，公网访问经由 nginx + TLS；
#   * 权限分离：面板以 xfmpanel 用户运行，特权操作交给 root 的 xfmpanel-agent。
# =============================================================================
set -euo pipefail

APP_DIR=/opt/xfmpanel
ETC_DIR=/etc/xfmpanel
DATA_DIR=/var/lib/xfmpanel
LOG_DIR=/var/log/xfmpanel
WWW_ROOT=/www/xfm
BACKUP_DIR=/var/backups/xfmpanel
NODE_MAJOR=22

BIND=127.0.0.1
BIND_EXPLICIT=0
PORT=8787
PROXY_DOMAIN=""
PUBLIC_URL=""
PUBLIC_IP=""
PUBLIC_IPV4=""
PUBLIC_IPV6=""
IP_FAMILY=""            # 自动选择的主访问地址族：ipv4 | ipv6
DETECT=1
PREFER_IPV6=0
SKIP_NODE=0
LOW_MEM=""              # 空=按内存自动判断；1=强制低内存；0=强制标准
ENABLE_SWAP=1
SWAP_MB=1024
FROM_SRC="${XFMP_SRC_URL:-}"   # 源码来源：owner/repo[@ref] | git URL | tar 包 URL
SRC_REF="${XFMP_SRC_REF:-}"
KEEP_SRC=0
SRC_DIR=""
SRC_TMP=""
FETCHED_DIR=""
GIT_LOG=""
DEFAULT_REPO="xfm0797/xfmpanel"   # --from 缺省时的源码仓库（跟随其默认分支）

# 无人值守安装：避免 apt/dpkg 弹 debconf 交互卡住 SSH 会话
export DEBIAN_FRONTEND=noninteractive

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[36m'; DIM=$'\033[2m'; NC=$'\033[0m'
info() { echo "${BLUE}==>${NC} $*"; }
ok()   { echo "${GREEN}  ✓${NC} $*"; }
warn() { echo "${YELLOW}  !${NC} $*"; }
die()  { echo "${RED}  ✗ $*${NC}" >&2; exit 1; }

usage() {
  cat <<'USAGE'
XFMPanel 安装 / 升级脚本（Debian 12 / Ubuntu 22.04+）

用法：
  sudo bash install.sh [选项]
  wget -qO- <install.sh 地址> | sudo bash -s -- [选项]
  sudo bash install.sh --from https://github.com/xfm0797/xfmpanel.git

选项：
  --proxy-domain <域名>   生成 nginx 反代配置（面板转为只监听 127.0.0.1）
  --public-url <URL>      对外访问地址，默认按探测结果生成
  --public-ip <IP>        手工指定公网地址，跳过在线探测
  --port <端口>           面板监听端口，默认 8787
  --bind <地址>           手工指定监听地址，默认自动（有反代 127.0.0.1，否则 0.0.0.0）
  --prefer-ipv6           有多栈地址时优先使用 IPv6 生成访问链接
  --no-detect             跳过地址探测
  --from <来源>           源码来源：owner/repo[@ref]、git 地址或 tar.gz 地址
  --ref <分支/标签>       配合 --from 指定分支或 tag
  --keep-src              保留临时下载的源码目录（排查用）
  --skip-node             跳过 Node.js 安装/升级
  --low-memory            强制启用低内存配置（≤1G 内存自动启用）
  --no-low-memory         强制使用标准配置
  --no-swap               低内存机型不自动创建 swap
  -h, --help              显示本帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bind) BIND="$2"; BIND_EXPLICIT=1; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy-domain) PROXY_DOMAIN="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --from) FROM_SRC="$2"; shift 2 ;;
    --ref) SRC_REF="$2"; shift 2 ;;
    --keep-src) KEEP_SRC=1; shift ;;
    --prefer-ipv6) PREFER_IPV6=1; shift ;;
    --no-detect) DETECT=0; shift ;;
    --skip-node) SKIP_NODE=1; shift ;;
    --low-memory) LOW_MEM=1; shift ;;
    --no-low-memory) LOW_MEM=0; shift ;;
    --no-swap) ENABLE_SWAP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 执行（sudo bash install.sh）"

# ---------------------------------------------------------------- 源码来源
# 脚本可能是 wget/curl 管道喂给 bash 的（此时没有仓库目录），也可能是单独一个
# install.sh 文件，所以这里先判断有没有本地源码，没有就自己拉一份。
is_project_dir() { [[ -f "$1/package.json" && -d "$1/panel/src" && -d "$1/agent/src" ]]; }

local_source_dir() {
  local p="${BASH_SOURCE[0]:-}" dir
  if [[ -n "$p" && -f "$p" ]]; then
    dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd)" || dir=""
    if [[ -n "$dir" ]] && is_project_dir "$dir"; then printf '%s' "$dir"; return 0; fi
    dir="$(cd "$(dirname "$p")/.." 2>/dev/null && pwd)" || dir=""
    if [[ -n "$dir" ]] && is_project_dir "$dir"; then printf '%s' "$dir"; return 0; fi
  fi
  if is_project_dir "$PWD"; then printf '%s' "$PWD"; return 0; fi
  return 1
}

cleanup_src() {
  [[ -n "$SRC_TMP" && -d "$SRC_TMP" ]] || return 0
  if [[ "$KEEP_SRC" -eq 1 ]]; then
    echo "${DIM}    临时源码保留在：${SRC_TMP}${NC}"
  else
    rm -rf -- "$SRC_TMP"
  fi
}
trap cleanup_src EXIT
trap 'cleanup_src; exit 130' INT TERM

# owner/repo → GitHub 地址；其余（git 地址、tar 地址、本地路径）原样返回
# 注意：这里不能修改全局变量（调用方用 $( ) 捕获输出，赋值会丢在子 shell 里）
normalize_source() {
  local spec="$1" repo="$1"
  [[ "$spec" == *"://"* || "$spec" == git@* || "$spec" == /* || -e "$spec" ]] && { printf '%s' "$spec"; return 0; }
  [[ "$repo" == */* ]] || die "无法识别的 --from 来源：${1}（示例：xfm0797/xfmpanel 或 https://github.com/xfm0797/xfmpanel.git）"
  printf 'https://github.com/%s.git' "$repo"
}

# owner/repo@ref → 拆成仓库与版本（只对简写形式生效；必须在当前 shell 里调用）
split_source_ref() {
  local spec="${FROM_SRC:-}"
  [[ -z "$spec" ]] && return 0
  [[ "$spec" == *"://"* || "$spec" == git@* || "$spec" == /* || -e "$spec" ]] && return 0
  if [[ "$spec" == *@* ]]; then
    [[ -n "$SRC_REF" ]] || SRC_REF="${spec##*@}"
    FROM_SRC="${spec%@*}"
  fi
}

find_project_root() {
  local base="$1" hit
  hit="$(find "$base" -maxdepth 3 -type f -name package.json -printf '%h\n' 2>/dev/null | head -n1 || true)"
  if [[ -n "$hit" && -d "$hit/panel/src" && -d "$hit/agent/src" ]]; then printf '%s' "$hit"; return 0; fi
  return 1
}

# 源码获取失败时给出可操作的替代方案
source_hint() {
  cat <<'HINT'
  可能原因：仓库不存在 / 私有仓库需要凭据 / 网络不通 / CDN 不可达。
  换一种来源重试：
    --from https://github.com/<owner>/<repo>.git
    --from https://<token>@github.com/<owner>/<repo>.git     # 私有仓库（只读 token）
    --from https://example.com/xfmpanel.tar.gz               # 预先上传的源码包
    --from /root/xfmpanel                                    # 已 scp 到本机的目录
HINT
}

# 静默 clone（禁止交互式账号密码提示，避免无人值守安装卡死），日志留到失败时打印
git_q() {
  local to=()
  command -v timeout >/dev/null && to=(timeout "${XFMP_FETCH_TIMEOUT:-180}")
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true "${to[@]}" git "$@" >>"${GIT_LOG:-/dev/null}" 2>&1
}

clone_failed() {
  if [[ -s "${GIT_LOG:-}" ]]; then
    tail -n 3 "$GIT_LOG" | sed 's/^/    /' || true
  fi
  die "克隆失败：${1}
$(source_hint)"
}

# 拉取源码到临时目录；结果写入 FETCHED_DIR（注意：进度信息走 stdout，不能用 stdout 返回路径）
fetch_source() {
  local spec dir archive root
  FETCHED_DIR=""
  spec="$(normalize_source "$1")"

  if [[ -d "$spec" ]]; then
    FETCHED_DIR="$spec"
    return 0
  fi

  dir="$(mktemp -d "${TMPDIR:-/tmp}/xfmpanel-src.XXXXXX")"
  SRC_TMP="$dir"
  GIT_LOG="$dir/git.log"

  case "$spec" in
    *.tar.gz|*.tgz|*.tar.xz|*.tar.bz2|*.tar)
      archive="$dir/src.tar"
      if [[ -f "$spec" ]]; then
        info "使用本地源码包：${spec}"
        cp -a "$spec" "$archive"
      else
        info "下载源码包：${spec}"
        curl -fL --retry 3 --connect-timeout 10 --max-time 300 -o "$archive" "$spec" \
          || die "源码包下载失败：${spec}
$(source_hint)"
      fi
      mkdir -p "$dir/unpack"
      # 用相对路径 + cd，避免某些环境把绝对路径误判成「主机:文件」
      ( cd "$dir/unpack" && tar -xf ../src.tar ) || die "源码包解压失败：${spec}"
      root="$(find_project_root "$dir/unpack" || true)"
      [[ -n "$root" ]] || die "源码包结构异常（未找到 package.json）"
      FETCHED_DIR="$root"
      ;;
    *)
      command -v git >/dev/null || apt-get install -y -qq git >/dev/null
      command -v git >/dev/null || die "需要 git 才能从 ${spec} 拉取源码"
      info "克隆源码：${spec}${SRC_REF:+ （${SRC_REF}）}"
      if [[ -n "$SRC_REF" ]]; then
        git_q clone --depth 1 --branch "$SRC_REF" "$spec" "$dir/repo" || {
          # tag / commit 用 --branch 可能失败，退化为完整克隆再检出
          rm -rf "$dir/repo"
          git_q clone "$spec" "$dir/repo" || clone_failed "$spec"
          git -C "$dir/repo" -c advice.detachedHead=false checkout -q "$SRC_REF" \
            || die "检出版本失败：${SRC_REF}"
        }
      else
        git_q clone --depth 1 "$spec" "$dir/repo" || clone_failed "$spec"
      fi
      rm -rf "$dir/repo/.git"
      FETCHED_DIR="$dir/repo"
      ;;
  esac
}

resolve_source() {
  local found
  if found="$(local_source_dir)"; then
    SRC_DIR="$found"
    ok "使用本地源码：${SRC_DIR}"
    return 0
  fi

  if [[ -z "$FROM_SRC" ]]; then
    FROM_SRC="$DEFAULT_REPO"
  fi
  split_source_ref
  # 提前校验来源格式，避免带着空来源去 clone（错误信息会莫名其妙）
  if [[ ! -e "$FROM_SRC" && "$FROM_SRC" != *"://"* && "$FROM_SRC" != git@* && "$FROM_SRC" != /* && "$FROM_SRC" != */* ]]; then
    die "无法识别的 --from 来源：${FROM_SRC}（示例：xfm0797/xfmpanel、https://…/xfmpanel.git、/root/xfmpanel.tar.gz）"
  fi

  fetch_source "$FROM_SRC"
  [[ -n "$FETCHED_DIR" && -f "$FETCHED_DIR/package.json" ]] || die "源码获取失败（${FROM_SRC}）"
  SRC_DIR="$FETCHED_DIR"
  ok "源码就绪：${SRC_DIR}"
}


# ---------------------------------------------------------------- 地址工具
is_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local IFS='.'
  for part in $ip; do
    ((10#$part <= 255)) || return 1
  done
  return 0
}

is_ipv6() {
  local ip="${1,,}"
  [[ "$ip" == *:* ]] || return 1
  [[ "$ip" =~ ^[0-9a-f:]+$ ]] || return 1
  [[ "$ip" != fe80* ]] || return 1
  [[ "$ip" != "::1" ]] || return 1
  return 0
}

is_private_v4() {
  local ip="$1"
  [[ "$ip" == 10.* || "$ip" == 127.* || "$ip" == 192.168.* || "$ip" == 169.254.* ]] && return 0
  if [[ "$ip" =~ ^172\.([0-9]{1,3})\. ]]; then
    local second="${BASH_REMATCH[1]}"
    ((second >= 16 && second <= 31)) && return 0
  fi
  [[ "$ip" =~ ^100\.([0-9]{1,3})\. ]] && ((BASH_REMATCH[1] >= 64 && BASH_REMATCH[1] <= 127)) && return 0
  return 1
}

# 从多个回显服务里取第一个合法地址：单一服务被墙/限流不影响安装
fetch_ip() {
  local fam="$1"; shift
  local url out
  for url in "$@"; do
    out="$(curl "-${fam}" -fsS --connect-timeout 3 --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$fam" == 4 ]] && is_ipv4 "$out"; then printf '%s' "$out"; return 0; fi
    if [[ "$fam" == 6 ]] && is_ipv6 "$out"; then printf '%s' "$out"; return 0; fi
  done
  return 1
}

# 默认路由出口地址：公网回显全部失败时兜底（NAT 型 VPS 会拿到内网 IP）
route_src_v4() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1 || true)"
  if is_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | while read -r a; do is_ipv4 "$a" && { echo "$a"; break; }; done)"
  if is_ipv4 "$ip"; then printf '%s' "$ip"; return 0; fi
  return 1
}

route_src_v6() {
  local ip
  ip="$(ip -6 route get 2001:4860:4860::8888 2>/dev/null | sed -n 's/.* src \([0-9a-fA-F:]*\).*/\1/p' | head -n1 || true)"
  if is_ipv6 "$ip"; then printf '%s' "$ip"; return 0; fi
  ip="$(ip -6 addr show scope global 2>/dev/null | sed -n 's/.*inet6 \([^/]*\)\/.*/\1/p' | head -n1 || true)"
  if is_ipv6 "$ip"; then printf '%s' "$ip"; return 0; fi
  return 1
}

url_host() {
  if [[ "$1" == *:* ]]; then printf '[%s]' "$1"; else printf '%s' "$1"; fi
}

# 幂等地补写/回填 panel.env 中的键（升级时用）
ensure_env() {
  local key="$1" val="$2" file="$ETC_DIR/panel.env"
  [[ -f "$file" ]] || return 0
  if grep -q "^${key}=" "$file"; then
    if grep -q "^${key}=$" "$file" && [[ -n "$val" ]]; then
      sed -i "s|^${key}=$|${key}=${val}|" "$file"
    fi
  elif [[ -n "$val" ]]; then
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

# URL 里是否可以放该地址（NAT 内网地址只用于展示，不作为默认访问入口）
detect_addresses() {
  if [[ "$DETECT" -eq 0 ]]; then
    ok "已跳过地址探测（--no-detect）"
    return 0
  fi

  command -v curl >/dev/null || apt-get install -y -qq curl >/dev/null

  info "探测本机访问地址（IPv4 / IPv6）"

  if [[ -n "$PUBLIC_IP" ]]; then
    if is_ipv4 "$PUBLIC_IP"; then
      PUBLIC_IPV4="$PUBLIC_IP"; IP_FAMILY=ipv4
    elif is_ipv6 "$PUBLIC_IP"; then
      PUBLIC_IPV6="$PUBLIC_IP"; IP_FAMILY=ipv6
    else
      die "--public-ip 不是合法地址：${PUBLIC_IP}"
    fi
    ok "使用手工指定地址：${PUBLIC_IP}"
    [[ -n "$PROXY_DOMAIN" ]] || { [[ "$BIND_EXPLICIT" -eq 1 ]] || BIND=0.0.0.0; }
    return 0
  fi

  PUBLIC_IPV4="$(fetch_ip 4 https://api.ipify.org https://ipv4.icanhazip.com https://ipv4.ident.me https://ifconfig.me/ip || true)"
  PUBLIC_IPV6="$(fetch_ip 6 https://api64.ipify.org https://ipv6.icanhazip.com https://v6.ident.me || true)"

  if [[ -z "$PUBLIC_IPV4" ]]; then
    PUBLIC_IPV4="$(route_src_v4 || true)"
    if [[ -n "$PUBLIC_IPV4" ]]; then
      warn "公网 IPv4 探测失败，回退到出口地址 ${PUBLIC_IPV4}（NAT 环境需自行做端口映射）"
    fi
  fi
  if [[ -z "$PUBLIC_IPV6" ]]; then
    PUBLIC_IPV6="$(route_src_v6 || true)"
  fi

  if [[ -z "$PUBLIC_IPV4" && -z "$PUBLIC_IPV6" ]]; then
    warn "未探测到任何可用地址（可能无外网或 IPv6 未启用），面板继续监听 ${BIND}"
    return 0
  fi

  if [[ -n "$PUBLIC_IPV4" ]]; then
    if is_private_v4 "$PUBLIC_IPV4"; then
      ok "本机 IPv4：${PUBLIC_IPV4} ${DIM}(内网地址)${NC}"
    else
      ok "公网 IPv4：${PUBLIC_IPV4}"
    fi
  else
    warn "未检测到 IPv4 地址"
  fi

  if [[ -n "$PUBLIC_IPV6" ]]; then
    ok "IPv6 地址：${PUBLIC_IPV6}"
  else
    echo "${DIM}    - 未检测到 IPv6（未启用或云厂商未分配，不影响 IPv4 访问）${NC}"
  fi

  # 主访问地址族：默认 IPv4（兼容性最好），可用 --prefer-ipv6 切换
  if [[ "$PREFER_IPV6" -eq 1 && -n "$PUBLIC_IPV6" ]]; then
    IP_FAMILY=ipv6
  elif [[ -n "$PUBLIC_IPV4" ]]; then
    IP_FAMILY=ipv4
  else
    IP_FAMILY=ipv6
  fi

  # 没有反代时监听所有地址，否则探测到的公网 IP 连不上
  if [[ "$BIND_EXPLICIT" -eq 0 ]]; then
    if [[ -n "$PROXY_DOMAIN" ]]; then
      BIND=127.0.0.1
    else
      BIND=0.0.0.0
    fi
  fi
}


# ---------------------------------------------------------------- 系统检查
info "检查系统环境"
command -v apt-get >/dev/null || die "当前脚本仅支持 Debian/Ubuntu；其它发行版请参考 docs/DEPLOYMENT.md 手工部署"
. /etc/os-release 2>/dev/null || true
ok "发行版：${PRETTY_NAME:-unknown}"

if ! command -v systemctl >/dev/null; then
  die "未检测到 systemd，请手工部署或使用容器方案"
fi

# ---------------------------------------------------------------- 低内存机型
MEM_MB="$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
[[ "$MEM_MB" =~ ^[0-9]+$ ]] || MEM_MB=0
if [[ -z "$LOW_MEM" ]]; then
  if [[ "$MEM_MB" -gt 0 && "$MEM_MB" -le 1024 ]]; then LOW_MEM=1; else LOW_MEM=0; fi
fi
if [[ "$LOW_MEM" -eq 1 ]]; then
  ok "内存 ${MEM_MB:-未知}MB → 启用低内存配置（任务并发 1、PHP 进程池收紧）"
else
  ok "内存 ${MEM_MB:-未知}MB → 使用标准配置"
fi

ensure_swap() {
  [[ "$ENABLE_SWAP" -eq 1 && "$LOW_MEM" -eq 1 ]] || return 0
  local cur
  cur="$(awk '/^SwapTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  [[ "$cur" =~ ^[0-9]+$ ]] || cur=0
  if [[ "$cur" -gt 0 ]]; then
    ok "swap 已启用（${cur}MB）"
    return 0
  fi
  if [[ -f /swapfile ]]; then
    if swapon /swapfile 2>/dev/null; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "已启用已有的 /swapfile"
    else
      warn "已有 /swapfile 但无法启用，跳过（可手动检查）"
    fi
    return 0
  fi
  info "创建 ${SWAP_MB}MB swap（低内存机型防 OOM）"
  if ! fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none 2>/dev/null \
      || { rm -f /swapfile; warn "swap 创建失败（磁盘空间不足？），继续安装"; return 0; }
  fi
  chmod 600 /swapfile
  if ! mkswap /swapfile >/dev/null 2>&1 || ! swapon /swapfile; then
    rm -f /swapfile
    warn "swap 启用失败，继续安装（建议手动配置 swap）"
    return 0
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  printf 'vm.swappiness = 10\n' > /etc/sysctl.d/99-xfmpanel-lowmem.conf
  sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true
  ok "swap 已启用：${SWAP_MB}MB（swappiness=10）"
}
ensure_swap

# ---------------------------------------------------------------- 基础依赖
info "检查基础依赖（curl / tar / ca-certificates）"
MISSING_PKGS=()
for b in curl tar; do
  command -v "$b" >/dev/null 2>&1 || MISSING_PKGS+=("$b")
done
if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  apt-get update -y -qq
  apt-get install -y -qq ca-certificates "${MISSING_PKGS[@]}"
fi
command -v curl >/dev/null || die "curl 安装失败，请手工安装后重试"
ok "基础依赖就绪"

# ---------------------------------------------------------------- 源码
# 单文件安装（wget/curl 下载的 install.sh 或管道执行）时，这里自动拉取仓库源码
resolve_source

# ---------------------------------------------------------------- Node.js
install_node() {
  info "安装 Node.js ${NODE_MAJOR}.x"
  apt-get update -y -qq
  apt-get install -y -qq ca-certificates curl gnupg
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; then
    apt-get install -y -qq nodejs
  else
    warn "NodeSource 源不可用，尝试发行版自带 nodejs"
    apt-get install -y -qq nodejs npm
  fi
}

if [[ "$SKIP_NODE" -eq 0 ]]; then
  if command -v node >/dev/null; then
    CUR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$CUR" -lt "$NODE_MAJOR" ]]; then
      warn "当前 Node $(node -v) 低于要求，升级中"
      install_node
    else
      ok "Node $(node -v) 已满足要求"
    fi
  else
    install_node
  fi
fi
command -v node >/dev/null || die "Node.js 安装失败，请手工安装 Node ${NODE_MAJOR}+"
NODE_BIN="$(command -v node)"
ok "Node 路径：${NODE_BIN}"

# ---------------------------------------------------------------- 地址探测
detect_addresses

# 计算对外访问地址（--public-url 优先，其次反代域名，最后探测到的地址）
if [[ -z "$PUBLIC_URL" ]]; then
  if [[ -n "$PROXY_DOMAIN" ]]; then
    PUBLIC_URL="https://${PROXY_DOMAIN}"
  elif [[ "$IP_FAMILY" == ipv6 && -n "$PUBLIC_IPV6" ]]; then
    PUBLIC_URL="http://$(url_host "$PUBLIC_IPV6"):${PORT}"
  elif [[ -n "$PUBLIC_IPV4" ]]; then
    PUBLIC_URL="http://${PUBLIC_IPV4}:${PORT}"
  else
    PUBLIC_URL="http://127.0.0.1:${PORT}"
  fi
fi

# ---------------------------------------------------------------- 用户与目录
info "创建运行用户与目录"
getent group xfmpanel >/dev/null || groupadd --system xfmpanel
if ! id -u xfmpanel >/dev/null 2>&1; then
  useradd --system --gid xfmpanel --home-dir "$DATA_DIR" --shell /usr/sbin/nologin xfmpanel
  ok "已创建系统用户 xfmpanel（禁止登录）"
else
  ok "用户 xfmpanel 已存在"
fi

install -d -m 0755 -o root -g root "$APP_DIR" "$ETC_DIR" "$WWW_ROOT"
install -d -m 0750 -o xfmpanel -g xfmpanel "$DATA_DIR" "$LOG_DIR"
install -d -m 0700 -o root -g root "$BACKUP_DIR"
ok "目录：${APP_DIR} ${ETC_DIR} ${DATA_DIR} ${LOG_DIR} ${WWW_ROOT}"

# ---------------------------------------------------------------- 代码
info "部署代码到 ${APP_DIR}"
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude '.git' --exclude 'data' --exclude 'node_modules' \
    --exclude '*.log' --exclude '.workbuddy' \
    "$SRC_DIR/" "$APP_DIR/"
else
  rm -rf "${APP_DIR:?}/panel" "${APP_DIR:?}/agent" "${APP_DIR:?}/shared" "${APP_DIR:?}/deploy" "${APP_DIR:?}/scripts"
  cp -a "$SRC_DIR/panel" "$SRC_DIR/agent" "$SRC_DIR/shared" "$SRC_DIR/deploy" "$SRC_DIR/scripts" "$SRC_DIR/package.json" "$APP_DIR/"
fi
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
ok "代码已同步（无 node_modules，零三方依赖）"

# ---------------------------------------------------------------- 密钥与配置
if [[ ! -f "$ETC_DIR/agent.secret" ]]; then
  umask 077
  openssl rand -hex 32 > "$ETC_DIR/agent.secret"
  ok "已生成 agent 通信密钥"
fi
chown root:xfmpanel "$ETC_DIR/agent.secret"
chmod 0640 "$ETC_DIR/agent.secret"

NEW_INSTALL=0
if [[ ! -f "$ETC_DIR/panel.env" ]]; then
  NEW_INSTALL=1
  info "生成面板配置 /etc/xfmpanel/panel.env"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-14)Aa1!"
  # 只有明确配置了反代才信任 X-Forwarded-For，直连部署下保持关闭
  TRUST_PROXY=0
  [[ -n "$PROXY_DOMAIN" ]] && TRUST_PROXY=1
  TASK_CONCURRENCY=2
  [[ "$LOW_MEM" -eq 1 ]] && TASK_CONCURRENCY=1
  cat > "$ETC_DIR/panel.env" <<EOF
# XFMPanel 面板配置 —— 由 install.sh 生成于 $(date -Is)
XFMP_ENV=prod
XFMP_BIND=${BIND}
XFMP_PORT=${PORT}
XFMP_PUBLIC_URL=${PUBLIC_URL}
# 安装时探测到的地址（IPv6 不带方括号），用于概览页展示与访问入口提示
XFMP_PUBLIC_IPV4=${PUBLIC_IPV4}
XFMP_PUBLIC_IPV6=${PUBLIC_IPV6}
XFMP_DATA_DIR=${DATA_DIR}
XFMP_DB=${DATA_DIR}/xfmpanel.db
XFMP_LOG_DIR=${LOG_DIR}
XFMP_AGENT_MODE=unix
XFMP_AGENT_SOCKET=/run/xfmpanel/agent.sock
XFMP_AGENT_SECRET_FILE=${ETC_DIR}/agent.secret
XFMP_COOKIE_SECURE=auto
XFMP_TRUST_PROXY=${TRUST_PROXY}
XFMP_TASK_CONCURRENCY=${TASK_CONCURRENCY}
XFMP_LOW_MEMORY=${LOW_MEM}
XFMP_TZ=Asia/Shanghai
# 首次启动会用它创建超级管理员，登录后可删除此行
XFMP_ADMIN_PASSWORD=${ADMIN_PASS}
EOF
  chown root:xfmpanel "$ETC_DIR/panel.env"
  chmod 0640 "$ETC_DIR/panel.env"

  cat > "$ETC_DIR/initial-admin.txt" <<EOF
XFMPanel 初始账号
=================
用户名：admin
密码：${ADMIN_PASS}
生成时间：$(date -Is)

首次登录后请立即修改密码，并删除本文件与 panel.env 中的 XFMP_ADMIN_PASSWORD。
EOF
  chmod 0600 "$ETC_DIR/initial-admin.txt"
  ok "已生成管理员账号（密码见 ${ETC_DIR}/initial-admin.txt）"
else
  ok "检测到已有面板配置，保留不动（升级模式）"
fi

# 老版本可能缺少这行，升级时补上
if ! grep -q '^XFMP_AGENT_SECRET_FILE=' "$ETC_DIR/panel.env"; then
  echo "XFMP_AGENT_SECRET_FILE=${ETC_DIR}/agent.secret" >> "$ETC_DIR/panel.env"
fi

# 升级：补写探测到的地址；旧的 127.0.0.1 占位 URL 在探测成功时一并纠正
ensure_env XFMP_PUBLIC_IPV4 "$PUBLIC_IPV4"
ensure_env XFMP_PUBLIC_IPV6 "$PUBLIC_IPV6"
# 低内存机型：老配置补齐标记；并发只在缺省时补为 1，不覆盖用户显式值
ensure_env XFMP_LOW_MEMORY "$LOW_MEM"
[[ "$LOW_MEM" -eq 1 ]] && ensure_env XFMP_TASK_CONCURRENCY 1
if [[ "$NEW_INSTALL" -eq 0 && -n "$PUBLIC_URL" ]]; then
  OLD_URL="$(sed -n 's/^XFMP_PUBLIC_URL=//p' "$ETC_DIR/panel.env" | head -n1)"
  if [[ "$OLD_URL" == "http://127.0.0.1:${PORT}" || "$OLD_URL" == "http://${BIND}:${PORT}" ]]; then
    sed -i "s|^XFMP_PUBLIC_URL=.*|XFMP_PUBLIC_URL=${PUBLIC_URL}|" "$ETC_DIR/panel.env"
    ok "已更新对外访问地址：${PUBLIC_URL}"
  fi
fi

# ---------------------------------------------------------------- systemd
info "安装 systemd 单元"
sed "s#/usr/bin/node#${NODE_BIN}#g" "$SRC_DIR/deploy/systemd/xfmpanel-agent.service" > /etc/systemd/system/xfmpanel-agent.service
sed "s#/usr/bin/node#${NODE_BIN}#g" "$SRC_DIR/deploy/systemd/xfmpanel-panel.service" > /etc/systemd/system/xfmpanel-panel.service

# 低内存机型：限制 Node 堆上限并降低 agent 并发（1 核场景避免同时跑多个重任务）
PANEL_DROPIN=/etc/systemd/system/xfmpanel-panel.service.d
AGENT_DROPIN=/etc/systemd/system/xfmpanel-agent.service.d
if [[ "$LOW_MEM" -eq 1 ]]; then
  install -d -m 0755 "$PANEL_DROPIN" "$AGENT_DROPIN"
  cat > "$PANEL_DROPIN/low-memory.conf" <<'EOF'
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=192
EOF
  cat > "$AGENT_DROPIN/low-memory.conf" <<'EOF'
[Service]
Environment=XFMP_AGENT_CONCURRENCY=2
Environment=NODE_OPTIONS=--max-old-space-size=160
EOF
  ok "已写入低内存 systemd 配置（panel 192MB / agent 160MB 堆上限）"
else
  rm -f "$PANEL_DROPIN/low-memory.conf" "$AGENT_DROPIN/low-memory.conf" 2>/dev/null || true
  rmdir "$PANEL_DROPIN" "$AGENT_DROPIN" 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable xfmpanel-agent >/dev/null 2>&1
systemctl enable xfmpanel-panel >/dev/null 2>&1
ok "单元已安装：xfmpanel-agent.service / xfmpanel-panel.service"

# ---------------------------------------------------------------- 启动
info "启动服务"
systemctl restart xfmpanel-agent
for i in $(seq 1 20); do
  [[ -S /run/xfmpanel/agent.sock ]] && break
  sleep 0.5
done
[[ -S /run/xfmpanel/agent.sock ]] || warn "未检测到 agent socket，请查看 journalctl -u xfmpanel-agent -n 50"

systemctl restart xfmpanel-panel

HEALTH_HOST="$BIND"
[[ "$BIND" == "0.0.0.0" ]] && HEALTH_HOST=127.0.0.1
[[ "$BIND" == "::" || "$BIND" == "[::]" ]] && HEALTH_HOST="[::1]"
HEALTH_URL="http://${HEALTH_HOST}:${PORT}/api/v1/system/health"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    ok "面板已就绪：${HEALTH_URL}"
    break
  fi
  sleep 1
done
curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 \
  || warn "面板健康检查未通过，请执行 journalctl -u xfmpanel-panel -n 100 查看原因"

# ---------------------------------------------------------------- 反向代理（可选）
if [[ -n "$PROXY_DOMAIN" ]]; then
  if ! command -v nginx >/dev/null; then
    warn "未安装 nginx，跳过反代配置；安装后可手动使用 deploy/nginx/xfmpanel.conf"
  else
    info "生成 nginx 反向代理：${PROXY_DOMAIN}"
    install -d -m 0755 /var/www/letsencrypt
    sed "s/panel.example.com/${PROXY_DOMAIN}/g" "$SRC_DIR/deploy/nginx/xfmpanel.conf" \
      > "/etc/nginx/sites-available/xfmpanel.conf"
    ln -sf /etc/nginx/sites-available/xfmpanel.conf /etc/nginx/sites-enabled/xfmpanel.conf
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      ok "反代已启用（证书路径需先签好，否则 nginx -t 会失败）"
      echo "${DIM}    申请证书：certbot certonly --webroot -w /var/www/letsencrypt -d ${PROXY_DOMAIN}${NC}"
    else
      warn "nginx -t 未通过（通常是因为证书文件还不存在），已保留配置未重载："
      nginx -t 2>&1 | sed 's/^/    /'
    fi
  fi
fi

# ---------------------------------------------------------------- 收尾
echo
echo "${GREEN}──────────────────────────────────────────────${NC}"
echo "${GREEN} XFMPanel 安装完成${NC}"
echo "${GREEN}──────────────────────────────────────────────${NC}"
echo " 登录地址："
if [[ -n "$PROXY_DOMAIN" ]]; then
  echo "   域名   : https://${PROXY_DOMAIN}"
fi
if [[ "$BIND" != "127.0.0.1" ]]; then
  if [[ -n "$PUBLIC_IPV4" ]]; then
    echo "   IPv4   : http://${PUBLIC_IPV4}:${PORT}"
  fi
  if [[ -n "$PUBLIC_IPV6" ]]; then
    echo "   IPv6   : http://$(url_host "$PUBLIC_IPV6"):${PORT}   ${DIM}(需本机与客户端都启用 IPv6)${NC}"
  fi
fi
echo "   本机   : http://127.0.0.1:${PORT}"
echo " 监听地址   : ${BIND}:${PORT}   ${DIM}(XFMP_BIND，可在 ${ETC_DIR}/panel.env 调整)${NC}"
echo " 配置文件   : ${ETC_DIR}/panel.env"
echo " 数据目录   : ${DATA_DIR}"
echo " 站点根目录 : ${WWW_ROOT}"
echo " 服务管理   : systemctl status xfmpanel-panel xfmpanel-agent"
echo " 日志       : journalctl -u xfmpanel-panel -f   /   ${LOG_DIR}/panel.log"

# 防火墙提示：不自动改防火墙规则，避免替用户放行未知来源
if [[ "$BIND" != "127.0.0.1" ]]; then
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -qi active; then
    echo "${YELLOW} 防火墙：${NC}ufw 处于启用状态，如需公网访问请执行 → ufw allow ${PORT}/tcp"
  elif command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
    echo "${YELLOW} 防火墙：${NC}firewalld 处于启用状态，如需公网访问请放行 ${PORT}/tcp"
  else
    echo "${DIM} 防火墙：未检测到启用中的 ufw/firewalld；若使用云厂商安全组，请放行 ${PORT}/tcp${NC}"
  fi
fi

if [[ "$NEW_INSTALL" -eq 1 ]]; then
  echo
  echo "${YELLOW} 初始账号密码：${NC}"
  sed 's/^/   /' "$ETC_DIR/initial-admin.txt"
fi

if [[ "$BIND" != "127.0.0.1" && -z "$PROXY_DOMAIN" ]]; then
  echo
  echo "${YELLOW} 安全提示：面板当前直接监听公网 HTTP（${BIND}:${PORT}），登录口令与 Cookie 为明文传输。${NC}"
  echo "${DIM}   生产环境建议改用：sudo ./deploy/install.sh --proxy-domain panel.example.com${NC}"
  echo "${DIM}   由 nginx 终止 TLS 并只允许面板监听 127.0.0.1；或至少用安全组限制来源 IP。${NC}"
fi
echo
echo " 后续步骤："
echo "   1) 登录后到「网站环境」安装 Nginx / PHP（可选 MariaDB、Redis）"
echo "   2) 在「系统设置」填写 ACME 邮箱，确保证书到期提醒可达"
echo "   3) 用 nginx 反代 + Let's Encrypt 暴露面板，并限制来源 IP"
echo
