#!/bin/bash
# =============================================================================
# Muster 快速启动测试（Finder 双击运行）
#
#   - 相对路径：脚本自动 cd 到自身所在目录（项目根目录），全部命令用相对路径
#   - 单实例守护：同一时刻只允许一个实例。检测到本项目已有实例（任意端口）时，
#     既不结束它、也不启动新实例——提示你手动关闭后重新双击；端口被其他程序
#     占用时同样提示并退出，不误杀
#   - 退出清理：关闭窗口 / Ctrl+C 时自动停止本脚本启动的服务
#
# 流程：结束旧实例 → npm run dev → 等待 /api/health 就绪 →
#       打开浏览器 → 保持运行直到窗口关闭
# 注意：不再自动跑冒烟测试。冒烟测试会向生产库写入测试公司/人员，
#       需要验证时手动执行: node scripts/smoke/run-all.mjs
# =============================================================================

# 切换到脚本所在目录（项目根目录），之后全部使用相对路径
cd "$(dirname "$0")" || { echo "!! 无法进入项目目录"; exit 1; }
PROJECT_ROOT="$(pwd)"
PORT="${MUSTER_PORT:-3456}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
LOG_FILE="tmp-muster-dev.log"

# 项目路径转义为正则，避免特殊字符干扰匹配
ESCAPED_ROOT="$(printf '%s' "$PROJECT_ROOT" | sed 's/[.[\*^$()+?{|]/\\&/g')"
# 只匹配本项目路径下的 dev/prod 服务进程；[s]erver 写法避免匹配到本脚本自身
STALE_PATTERN="${ESCAPED_ROOT}.*[s]erver\.[tj]s"

DEV_PID=""

# 递归结束进程树（npm → sh → tsx → node）
kill_tree() {
  local pid="$1" sig="$2"
  local kids
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  for k in $kids; do
    kill_tree "$k" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM HUP   # 防止信号递归触发
  # 只清理本脚本启动的服务（DEV_PID 进程树），绝不按路径全局清理——
  # 否则会误杀用户手动开启的实例（这是本脚本要保护的对象）。
  if [ -n "$DEV_PID" ]; then
    echo
    echo "==> 正在停止 Muster 服务…"
    if kill -0 "$DEV_PID" 2>/dev/null; then
      kill_tree "$DEV_PID" TERM
      sleep 2
      kill_tree "$DEV_PID" KILL
    fi
    echo "==> 服务已停止，窗口可安全关闭"
  fi
  exit 0
}
trap cleanup EXIT INT TERM HUP

echo "============================================================="
echo " Muster 快速启动测试"
echo "   项目目录: $PROJECT_ROOT"
echo "   服务端口: $PORT"
echo "============================================================="

# --- 1. 环境预检 ---
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "!! 未找到 node/npm，请先安装 Node.js >= 22"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "!! 未找到 node_modules，请先执行: npm install"
  exit 1
fi

# --- 2. 单实例守护：检测到本项目已有实例（任意端口）时，不结束、不启动，提示手动处理 ---
STALE_PIDS="$(pgrep -f "$STALE_PATTERN" 2>/dev/null | grep -v "^$$\$" || true)"
if [ -n "$STALE_PIDS" ]; then
  echo
  echo "!! 检测到本项目已有实例在运行 (PID: $(echo "$STALE_PIDS" | tr '\n' ' '))"
  echo "   同一时刻只允许一个实例，本脚本不会结束或替换它，也不会启动新实例。"
  echo "   请先手动关闭现有实例（可执行: kill -9 $(echo "$STALE_PIDS" | tr '\n' ' ')，"
  echo "   或关闭它的终端窗口），再重新双击本文件启动。"
  exit 0
fi

# --- 3. 端口复查：被占用时不结束占用者，提示手动处理 ---
OWNER_PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$OWNER_PID" ]; then
  OWNER_CMD="$(ps -p "$OWNER_PID" -o command= 2>/dev/null || true)"
  echo
  if printf '%s' "$OWNER_CMD" | grep -qE 'server\.(ts|js)|tsx|muster'; then
    echo "!! 端口 $PORT 已被本项目/其他 Muster 实例占用 (PID $OWNER_PID)"
    echo "   本脚本不会结束或替换正在运行的实例。请先手动关闭该实例，再重新双击本文件。"
  else
    echo "!! 端口 $PORT 被其他程序占用: PID $OWNER_PID"
    echo "   $OWNER_CMD"
    echo "   为避免误杀，已停止启动。请先结束该程序，或设置 MUSTER_PORT 换端口后重试。"
  fi
  exit 0
fi

# --- 4. 启动开发服务（后台运行，日志写入项目根目录） ---
echo "==> 启动开发服务: npm run dev"
rm -f "$LOG_FILE"
npm run dev > "$LOG_FILE" 2>&1 &
DEV_PID=$!

# --- 5. 等待健康检查就绪（最多 60 秒） ---
READY=0
for i in $(seq 1 60); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "!! 服务进程提前退出，最近日志:"
    tail -30 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "!! 等待服务就绪超时（60 秒），最近日志:"
  tail -30 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi
echo "==> 服务就绪: $HEALTH_URL"

# --- 6. 打开浏览器 ---
open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && echo "==> 已在浏览器打开: http://127.0.0.1:${PORT}/"

# --- 7. 保持运行，等待用户操作；关闭窗口或 Ctrl+C 时自动停止服务 ---
echo
echo "============================================================="
echo " Muster 测试环境运行中"
echo "   服务地址: http://127.0.0.1:${PORT}/"
echo "   健康检查: $HEALTH_URL"
echo "   服务日志: $LOG_FILE   （tail -f $LOG_FILE 实时查看）"
echo " 停止: 按 Ctrl+C，或直接关闭本窗口（服务自动退出）"
echo "============================================================="
echo
wait "$DEV_PID"
CODE=$?
echo "==> 服务已退出 (exit=$CODE)"
