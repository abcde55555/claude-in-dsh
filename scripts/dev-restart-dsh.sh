#!/usr/bin/env bash
# 开发用：重启 trial profile 的 dsh web，并打印带 token 的地址。
#
# ⚠️ 它会先停旧进程（同一个端口没法跑两个）。所以新代码起不来 = 旧进程没了。
#    失败时脚本会把完整日志打出来并以非零退出 —— 别让这个错误被吞掉。
#
# 重启 dsh 会杀掉它自己会话里在跑的轮次：crash recovery 把未完成的工具调用结算成
# TOOL_OUTCOME_UNKNOWN（对话里那张红卡片）。所以**默认先等在跑的轮次结束**再停，
# 超时才停（--force 则不等）。这条是从仓库里既有的 scripts/safe-restart.sh 移植的
# —— 那边专门解决这件事，注释原话：「Especially important when more than one agent
# works on this machine: whoever restarts blindly interrupts the other.」
#
# 与 safe-restart.sh 的分工：那个管 pm2 托管的 dsh-web（:8090），本脚本管手起的
# trial profile（:3081）。**「调用者自己就是目标实例里的一轮」这种情况本脚本不处理**
# ——那种时候等待永远等不完，要派一个脱离本轮生命周期的看门狗，那套只有
# safe-restart.sh 有。在这里遇到会明确报错让你改 --force。
#
# 环境变量（OPENCODE_API_KEY / ANTHROPIC_* / 代理）的来源，按顺序取第一个可用的：
#
#   1. 可选的 ~/.config/cid/env（CID_ENV_FILE 可覆盖）—— 脚本**只读不写**，
#      密钥要不要落盘由你决定。建了它，「已经没有 dsh 在跑」也能重启。
#   2. 当前正在跑的 dsh 进程（macOS: ps eww）—— 不需要任何文件。
#
# 用法：bash scripts/dev-restart-dsh.sh [--wait SECONDS] [--force]
#   --wait N  等在跑的轮次结束的秒数（默认 120）
#   --force   不等，直接重启
# 环境变量：DSH_PORT（默认 3081）、DSH_PROFILE（默认 trial）
set -uo pipefail

PORT="${DSH_PORT:-3081}"
PROFILE="${DSH_PROFILE:-trial}"
NODE_BIN="${HOME}/.local/node24/bin"
DSH_DIR="${HOME}/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh"
OUT="/tmp/dsh-${PROFILE}.log"
ENV_FILE="${CID_ENV_FILE:-${HOME}/.config/cid/env}"

KEYS='OPENCODE_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN HTTPS_PROXY HTTP_PROXY NO_PROXY'

WAIT=120
FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="${2:-120}"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 -h 看用法）" >&2; exit 2 ;;
  esac
done

cold_start_hint() {
  cat <<HINT

冷启动命令（把 <...> 换成真实值，或直接建 ${ENV_FILE}）：
  cd ~ && export PATH="\$HOME/.local/node24/bin:\$PATH"
  export OPENCODE_API_KEY=<...> ANTHROPIC_BASE_URL=<...>
  export ANTHROPIC_API_KEY=<...> ANTHROPIC_AUTH_TOKEN=<...>
  export HTTPS_PROXY=<...> HTTP_PROXY=<...> NO_PROXY="127.0.0.1,localhost"
  node ${DSH_DIR}/lib/bin.js --profile ${PROFILE} --port ${PORT} --no-open > ${OUT} 2>&1 &
  grep -o "token=[A-Za-z0-9_-]*" ${OUT}
HINT
}

# ── 1. 收集环境变量 ────────────────────────────────────────────────
env_args=()
source_kind=''

if [ -f "$ENV_FILE" ]; then
  # 只认白名单里的 KEY=VALUE 行，不 source —— 文件里塞别的东西不会被执行。
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

# ── 2. 等在跑的轮次结束 ────────────────────────────────────────────
# 调用者自己往往就是目标实例里的一轮（在 dsh 会话里跑这个脚本时）——那一轮永远等
# 不完。walk 进程树找自己所属的 broker（命令行里有 /tmp/ccmode/session-<uuid>），
# 等的时候把它排除。safe-restart.sh 用的是 /proc，那是 Linux 专有；这里用 ps。
caller_session() {
  local pid=$$ cmd ppid
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *broker.mjs*)
        printf '%s\n' "$cmd" | grep -oE '/tmp/ccmode/session-[0-9a-fA-F-]+' | head -1 | sed 's|.*/||'
        return ;;
    esac
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ "$ppid" = "$pid" ] && break
    pid="$ppid"
  done
}

# 插件自己的 busy RPC：返回在跑的轮次。没起/超时就当「没有」。
busy_turns() {
  curl -s -m 5 -X POST "http://127.0.0.1:${PORT}/claude-in-dsh/rpc" \
    -H 'content-type: application/json' -d '{"method":"busy","args":{}}' 2>/dev/null \
    | SKIP="${1:-}" "${NODE_BIN}/node" -e '
      let raw = ""
      process.stdin.on("data", (chunk) => { raw += chunk })
      process.stdin.on("end", () => {
        try {
          const answer = JSON.parse(raw)
          const turns = answer && answer.ok && answer.value ? (answer.value.turns || []) : []
          const skip = process.env.SKIP || ""
          console.log(turns
            .filter((t) => skip === "" || t.sessionId !== skip)
            .map((t) => t.sessionId + "#" + t.turn).join(","))
        } catch (error) { console.log("") }
      })'
}

if [ -n "$old_pid" ] && [ "$FORCE" != true ]; then
  skip="$(caller_session)"
  [ -n "$skip" ] && echo "调用者自己属于会话 ${skip}（那一轮不算数）"
  deadline=$(( $(date +%s) + WAIT ))
  while :; do
    live="$(busy_turns "$skip")"
    [ -z "$live" ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "⚠️ 等了 ${WAIT}s 仍有轮次在跑：${live}"
      echo "   继续重启会在对方的对话里留下 TOOL_OUTCOME_UNKNOWN（红卡片）。"
      echo "   确定要打断就加 --force；想继续等就调大 --wait。"
      exit 3
    fi
    echo "有轮次在跑（${live}），等待中…（--force 可跳过）"
    sleep 5
  done
  echo "没有在跑的轮次"
fi

# ── 3. 停旧进程 ────────────────────────────────────────────────────
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

# ── 4. 起新进程 ────────────────────────────────────────────────────
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

# ── 5. 结果：成功给地址，失败把日志摊开并明确失败 ──────────────────
if [ "$ready" = true ]; then
  grep -E "host v|client v|restored settings|dsh web" "$OUT"
  exit 0
fi

echo
echo "❌ 新 dsh 没起来（pid=${new_pid}，日志 ${OUT}）。"
echo "   旧进程已被停掉，它的环境变量也随之没了 —— 重试靠 ${ENV_FILE} 就够了。"
echo "────────────── 日志全文 ──────────────"
cat "$OUT"
echo "──────────────────────────────────────"
cold_start_hint
exit 1
