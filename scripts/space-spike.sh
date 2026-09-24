#!/usr/bin/env bash
# 用指定宿主形态重启 BrowserOS neo（P7-C 宿主形态 spike 用）。
#
#   用法: scripts/space-spike.sh view|widget|window|off
#         （也接受 i / ii / iii；off = 正常启动，不带开关）
#
# 它会先退出正在运行的 app（避免重链覆盖正在运行的 framework / 避免旧进程占着端口），
# 再用 --space-spike=<form> 重新启动。app 直接从构建产物目录运行，不需要安装。
set -euo pipefail

APP="${APP:-/Volumes/SN850X_2T/hub-browser/src/out/Default_browserclaw_arm64/BrowserOS neo.app}"
BIN="$APP/Contents/MacOS/BrowserOS neo"

FORM="${1:-}"
case "$FORM" in
  i)   FORM=view ;;
  ii)  FORM=widget ;;
  iii) FORM=window ;;
  view|widget|window|off) ;;
  *) echo "用法: $0 view|widget|window|off   （或 i|ii|iii）" >&2; exit 2 ;;
esac

[ -x "$BIN" ] || { echo "✗ 找不到 app：$APP" >&2; exit 1; }

if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "→ 退出正在运行的 BrowserOS neo…"
  osascript -e 'tell application "BrowserOS neo" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    pgrep -f "$BIN" >/dev/null 2>&1 || break
    sleep 0.25
  done
  if pgrep -f "$BIN" >/dev/null 2>&1; then
    echo "  （没响应 quit，强制结束）"
    pkill -f "$BIN" || true
    sleep 1
  fi
fi

if [ "$FORM" = "off" ]; then
  echo "→ 正常启动（不带 spike 开关）"
  open -a "$APP"
else
  echo "→ 启动：--space-spike=$FORM"
  open -a "$APP" --args --space-spike="$FORM"
fi
echo "✓ 已发出启动指令（app 起来大约需要 2–5 秒）"
