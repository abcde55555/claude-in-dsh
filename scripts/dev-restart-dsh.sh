#!/usr/bin/env bash
# 开发用：重启 trial profile 的 dsh web，并打印带 token 的地址。
#
# 环境变量（OPENCODE_API_KEY / ANTHROPIC_* / 代理）从**当前正在跑的 dsh 进程**
# 里读出来，而不是写在脚本或文件里 —— 免得 key 落到磁盘上。所以这个脚本要求
# 「已经有一个 dsh 在跑」才能拿到完整环境；冷启动请直接照原命令敲。
#
# 用法：bash scripts/dev-restart-dsh.sh [--keep-env]
set -euo pipefail

PORT="${DSH_PORT:-3081}"
PROFILE="${DSH_PROFILE:-trial}"
NODE_BIN="${HOME}/.local/node24/bin"
DSH_DIR="${HOME}/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh"
OUT="${TMPDIR:-/tmp}/cid-dsh-restart.log"

KEYS='OPENCODE_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY'

old_pid="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -z "$old_pid" ]; then
  echo "✋ 没有正在跑的 dsh（profile=${PROFILE} port=${PORT}），拿不到环境变量。"
  echo "   冷启动请照 README/会话记录里的完整命令敲。"
  exit 2
fi
echo "占用 ${PORT} 的是 pid=${old_pid}"

# 从进程环境里捞变量（macOS: ps eww）。
env_args=()
raw="$(ps eww -p "$old_pid" | tail -n +2)"
for k in $KEYS; do
  v="$(printf '%s' "$raw" | tr ' ' '\n' | grep -m1 "^${k}=" || true)"
  [ -n "$v" ] && env_args+=("$v")
done
echo "抓到 ${#env_args[@]} 个环境变量"

# 按端口找占用者：pgrep 会连 shell 包装器一起匹到，杀错了端口不释放。
kill "$old_pid" 2>/dev/null || true
for _ in $(seq 1 20); do
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1 || break
  sleep 0.5
done
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "旧进程没让出 ${PORT}，强杀"
  kill -9 "$old_pid" 2>/dev/null || true
  sleep 1
fi
echo "已停旧进程 ${old_pid}，${PORT} 已释放"

cd "$HOME"
export PATH="${NODE_BIN}:$PATH"
nohup env "${env_args[@]}" node "${DSH_DIR}/lib/bin.js" \
  --profile "$PROFILE" --port "$PORT" --no-open >"$OUT" 2>&1 &

for _ in $(seq 1 40); do
  if grep -q "dsh web: http" "$OUT" 2>/dev/null; then break; fi
  sleep 1
done
echo
grep -E "host v|restored settings|dsh web" "$OUT" || tail -5 "$OUT"
