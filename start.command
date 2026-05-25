#!/bin/bash
cd "$(dirname "$0")"
SCRIPT_PID=$$

# 关闭旧进程
lsof -ti :3456 2>/dev/null | while read pid; do
  [ "$pid" != "$SCRIPT_PID" ] && kill "$pid" 2>/dev/null
done
sleep 0.5

echo "🚀 Muster v2 — http://localhost:3456"
echo "日志: /tmp/muster.log"
echo "关闭此终端将自动停止服务"

# 启动 node（不用 nohup，保证终端关闭时 trap 能杀掉子进程）
node server.js > /tmp/muster.log 2>&1 &
NODE_PID=$!

# 终端关闭时自动结束 node
trap "kill $NODE_PID 2>/dev/null; exit" EXIT HUP INT TERM

open http://localhost:3456

# 保持脚本存活，等 node 结束
wait $NODE_PID
