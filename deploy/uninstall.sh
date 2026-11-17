#!/usr/bin/env bash
# =============================================================================
# XFMPanel 卸载脚本
#
#   sudo ./deploy/uninstall.sh              # 停止并移除服务与代码，保留数据与站点
#   sudo ./deploy/uninstall.sh --purge      # 额外删除数据库、配置、日志、备份
#   sudo ./deploy/uninstall.sh --purge --purge-sites   # 连站点文件一起删除（危险）
# =============================================================================
set -euo pipefail

APP_DIR=/opt/xfmpanel
ETC_DIR=/etc/xfmpanel
DATA_DIR=/var/lib/xfmpanel
LOG_DIR=/var/log/xfmpanel
WWW_ROOT=/www/xfm

PURGE=0
PURGE_SITES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --purge-sites) PURGE_SITES=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }

echo "==> 停止服务"
systemctl stop xfmpanel-panel 2>/dev/null || true
systemctl stop xfmpanel-agent 2>/dev/null || true
systemctl disable xfmpanel-panel 2>/dev/null || true
systemctl disable xfmpanel-agent 2>/dev/null || true
rm -f /etc/systemd/system/xfmpanel-panel.service /etc/systemd/system/xfmpanel-agent.service
systemctl daemon-reload

echo "==> 移除代码：${APP_DIR}"
rm -rf "$APP_DIR"

if [[ "$PURGE" -eq 1 ]]; then
  echo "==> 删除数据 / 配置 / 日志"
  rm -rf "$DATA_DIR" "$ETC_DIR" "$LOG_DIR"
  if id -u xfmpanel >/dev/null 2>&1; then
    userdel xfmpanel 2>/dev/null || true
    groupdel xfmpanel 2>/dev/null || true
  fi
fi

if [[ "$PURGE_SITES" -eq 1 ]]; then
  echo "==> 删除所有站点文件：${WWW_ROOT}"
  if [[ -d "$WWW_ROOT" ]]; then
    for d in "$WWW_ROOT"/*; do
      [[ -d "$d" ]] || continue
      slug="$(basename "$d")"
      if id -u "xfm_${slug}" >/dev/null 2>&1; then
        userdel "xfm_${slug}" 2>/dev/null || true
      fi
    done
    rm -rf "$WWW_ROOT"
  fi
  echo "    nginx vhost 与 php-fpm pool 需要手工清理：/etc/nginx/sites-*/*, /etc/php/*/fpm/pool.d/xfm-*"
fi

echo
echo "卸载完成。"
[[ "$PURGE" -eq 0 ]] && echo "数据保留在：${DATA_DIR} ${ETC_DIR} ${LOG_DIR}"
[[ "$PURGE_SITES" -eq 0 ]] && echo "站点文件保留在：${WWW_ROOT}"
