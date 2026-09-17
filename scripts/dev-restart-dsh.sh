#!/usr/bin/env bash
# 开发用：重启 trial profile 的 dsh web，并打印带 token 的地址。
#
# 环境变量（OPENCODE_API_KEY / ANTHROPIC_* / 代理）的来源，按顺序取第一个可用的：
#
#   1. 当前正在跑的 dsh 进程（macOS: ps eww）—— 脚本不写任何密钥到磁盘。
#   2. 可选的 ~/.config/cid/env —— 你若自己建了这个文件（建议 chmod 600），
#      冷启动和「上一次启动失败」时就能从这里拿。脚本**只读不写**，密钥要不要
#      落盘由你决定。
#
# 两条都没有时直接报错退出，并把冷启动命令原样打出来。
#
# ⚠️ 它会先停旧进程（同一个端口没法跑两个）。所以新代码起不来 = 旧进程没了。
#    失败时脚本会把完整日志打出来并以非零退出 —— 别让这个错误被吞掉。
#
# 用法：bash scripts/dev-restart-dsh.sh
# 环境变量：DSH_PORT（默认 3081）、DSH_PROFILE（默认 trial）
set -uo pipefail

PORT="${DSH_PORT:-3081}"
PROFILE="${DSH_PROFILE:-trial}"
NODE_BIN="${HOME}/.local/node24/bin"
DSH_DIR="${HOME}/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh"
OUT="/tmp/dsh-${PROFILE}.log"
ENV_FILE="${CID_ENV_FILE:-${HOME}/.config/cid/env}"

KEYS='OPENCODE_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY'

cold_start_hint() {
  cat <<HINT

冷启动命令（把 <...> 换成真实值）：
  cd ~ && export PATH="\$HOME/.local/node24/bin:\$PATH"
  export OPENCODE_API_KEY=<...> ANTHROPIC_BASE_URL=<...>
  export ANTHROPIC_API_KEY=<...> ANTHROPIC_AUTH_TOKEN=<...>
  export HTTPS_PROXY=<...> HTTP_PROXY=<...> NO_PROXY="127.0.0.1,localhost"
  node ${DSH_DIR}/lib/bin.js --profile ${PROFILE} --port ${PORT} --no-open > ${OUT} 2>&1 &
  grep -o "token=[A-Za-z0-9_-]*" ${OUT}

或建一个 ${ENV_FILE}（chmod 600），内容就是上面那几行 export，
脚本下次自己会读它 —— 那样即使 dsh 没在跑也能重启。
HINT
}

# ── 1. 收集环境变量 ────────────────────────────────────────────────
env_args=()
source_kind=''

if [ -f "$ENV_FILE" ]; then
  # 只认 KEY=VALUE 行，避免把任意 shell 代码 source 进来。
  while IFS= read -r line; do
    case "$line" in \#*|'') continue ;; esac
    key="${line%%=*}"
    case " $KEYS " in
      *" $key "*) env_args+=("$line"); source_kind="$ENV_FILE" ;;
    esac
  done < <(sed -e 's/^[[:space:]]*export[[:space:]]*//' -e 's/^[[:space:]]*//' "$ENV_FILE")
fi

old_pid="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"

if [ ${#env_args[@]} -eq 0 ] && [ -n "$old_pid" ]; then
  # 从进程环境里捞（macOS: ps eww）。
  raw="$(ps eww -p "$old_pid" | tail -n +2)"
  for k in $KEYS; do
    v="$(printf '%s' "$raw" | tr ' ' '\n' | grep -m1 "^${k}=" || true)"
    [ -n "$v" ] && env_args+=("$v")
  done
  [ ${#env_args[@]} -gt 0 ] && source_kind="pid ${old_pid} 的进程环境"
fi

if [ ${#env_args[@]} -eq 0 ]; then
  echo "✋ 拿不到环境变量：既没有 ${ENV_FILE}，${PORT} 上也没有 dsh 在跑。"
  cold_start_hint
  exit 2
fi
echo "环境变量来源：${source_kind}（${#env_args[@]} 个）"

# ── 2. 停旧进程 ────────────────────────────────────────────────────
if [ -z "$old_pid" ]; then
  echo "${PORT} 上没有旧进程，直接起"
else
  echo "占用 ${PORT} 的是 pid=${old_pid}"
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
fi

# ── 3. 起新进程 ────────────────────────────────────────────────────
: >"$OUT"
cd "$HOME"
export PATH="${NODE_BIN}:$PATH"
nohup env "${env_args[@]}" node "${DSH_DIR}/lib/bin.js" \
  --profile "$PROFILE" --port "$PORT" --no-open >>"$OUT" 2>&1 &
new_pid=$!

ready=false
for _ in $(seq 1 40); do
  if grep -q "dsh web: http" "$OUT" 2>/dev/null; then ready=true; break; fi
  # 早退 = 装配就失败了（插件树起不来、TDZ、端口占用…），别干等满 40 秒。
  if ! kill -0 "$new_pid" 2>/dev/null; then break; fi
  sleep 1
done

# ── 4. 结果：成功给地址，失败把日志摊开并明确失败 ──────────────────
if [ "$ready" = true ]; then
  grep -E "host v|restored settings|dsh web" "$OUT"
  exit 0
fi

echo
echo "❌ 新 dsh 没起来（pid=${new_pid}，日志 ${OUT}）。"
echo "   旧进程已被停掉，它的环境变量也随之没了 —— 重试请靠 ${ENV_FILE} 或冷启动。"
echo "────────────── 日志全文 ──────────────"
cat "$OUT"
echo "──────────────────────────────────────"
cold_start_hint
exit 1
