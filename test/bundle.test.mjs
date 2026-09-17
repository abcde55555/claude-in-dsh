// The two generated bundle halves must load in their real containers:
// lib/index.js as an ES module with { apply, inject }, lib/client.js as a
// window.__ModuleLoader__ handoff whose factory wires the tested engine body.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('host half exports apply + inject', async () => {
  const mod = await import(path.join(root, 'lib/index.js'))
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['webServer', 'subprocess', 'timer'])
})

test('宿主半能装配起来（初始化顺序的回归防线）', async () => {
  // `const AGENTS_PATH = STATE_DIR + ...` 写在 STATE_DIR 之前时，import 和语法
  // 检查都看不出问题，只有真的 apply() 会炸成 "Cannot access 'STATE_DIR' before
  // initialization" —— 而它的表现是整个 dsh 起不来。所以这里用一套桩服务把它
  // 装配一遍。
  const mod = await import(path.join(root, 'lib/index.js'))
  const routes = []
  const effects = []
  // 预热期的错误日志收在这里。这一步是必要的：预热**失败会被它自己的 .catch
  // 吞掉只打日志**，所以「有没有炸」看不出来，只有日志里留着痕迹。
  //
  // 真实源码里少声明一个模块级变量（例如写了 `agentsCache = agents` 而漏掉
  // `let agentsCache`）在严格模式的 ESM 里会抛 ReferenceError —— 被吞掉之后就
  // 变成**静默降级**：插件照常起来，但用户配的连接被无声忽略。切片式的测试台抓
  // 不到这个（那些台子自己把模块级状态声明好了，被切的函数赋的是**台子给的**变量），
  // 所以只有这里能拦住它。
  const errors = []
  const realError = console.error
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    await runAssembly()
  } finally {
    console.error = realError
  }

  async function runAssembly() {
    // `runCapture` 里 `proc.done.then(...)` 与消费 `proc.stdout` 的循环是**竞态**：
    // done 抢在 stdout 被读完之前 resolve 的话，它拿到的 output 是空串，随后的
    // `JSON.parse('')` 抛错 → 上层 `catch { return agents }` 提前返回 → 预热根本
    // 走不到真实源码末尾那几行，测试也就永远看不见那里的错误。所以这里的 done
    // 必须在 stdout 消费完之后才 resolve。
    const fakeProc = (output) => {
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      const stdout = (async function* () {
        if (output.length > 0) yield output
        settle({ exitCode: 0 })
      })()
      return { stdout, stderr: (async function* () {})(), done, terminate() {} }
    }
    // 读文件的 `cat` 给一个合法的空 JSON，让预热**跑完整条路径**；真起进程的
    // （claude / codex / nohup…）装配期不该有，返回一个空进程即可 —— 有断言会
    // 检查预热没报错，真起了进程也会在那条断言里露出来。
    const subprocess = {
      spawn: (options) => {
        const argv = Array.isArray(options.argv) ? options.argv : []
        const command = String(argv[2] === undefined ? '' : argv[2])
        return fakeProc(argv[0] === '/bin/sh' && command.indexOf('cat ') === 0 ? '{}' : '')
      },
      resolveExecutable: (name) => Promise.resolve('/usr/bin/' + name),
    }
    const ctx = {
      // 引擎体是先 `ctx.get('subprocess')` 再装配的，缺了它整半会直接 idle 返回
      // ——那样这个测试就什么都没验到。
      get: (name) => (name === 'subprocess' ? subprocess : undefined),
      effect: (fn) => { effects.push(fn()); return () => {} },
      interval: () => () => {},
      timeout: () => () => {},
      on: () => {},
      provide: () => {},
      webServer: { register: (route) => { routes.push(route); return () => {} } },
    }
    assert.doesNotThrow(() => mod.apply(ctx))
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/claude-in-dsh/rpc')
    assert.equal(typeof routes[0].handler, 'function')
    assert.ok(effects.length > 0)
    // 引擎体装配完了才会挂上自己的 effect（interval / timeout 各一处以上）。
    assert.ok(effects.length >= 2, '引擎体像是提前 idle 返回了')

    // 等预热跑完，然后断言**读引擎注册表**这条没报错。只断言这一条：桩服务会让
    // 别的预热（读模型清单）也走同一条路，与本事无关。
    //
    // 这条断言做过变异验证：撤掉 `let agentsCache = null`、重建 bundle，它会带着
    // 「agentsCache is not defined」失败。
    await new Promise((resolve) => setTimeout(resolve, 100))
    const registryErrors = errors.filter((line) => line.indexOf('engine registry') !== -1)
    assert.equal(registryErrors.length, 0,
      '读引擎注册表失败了（多半是上面某个模块级变量漏了声明）：' + registryErrors.join(' | '))

    // 桩服务什么都不做，但半个宿主也不该因此崩掉。
    const answer = await routes[0].handler(
      { headers: { host: '127.0.0.1:3081' }, on: (name, fn) => { if (name === 'end') fn() } },
      { writeHead() {}, end() {} },
    )
    assert.equal(answer, undefined)
  }
})

test('client half registers through the module loader', () => {
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

  const handoffs = []
  const fakeWindow = {
    console: console,
    __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) },
  }
  const styleTags = []
  const fakeDocument = {
    createElement: () => {
      const tag = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v }, textContent: '' }
      return tag
    },
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: { setAttribute() {}, removeAttribute() {} },
    addEventListener() {},
    removeEventListener() {},
    getElementsByClassName: () => [],
    querySelectorAll: () => [],
  }
  const evaluate = new Function('window', 'document', 'fetch', 'MutationObserver', 'Element', source)
  evaluate(fakeWindow, fakeDocument, () => Promise.resolve({ json: () => ({ ok: true, value: {} }) }),
    class { observe() {} disconnect() {} }, class {})

  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].id, 'claude-in-dsh')

  const fakeReact = {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  const exports = handoffs[0].factory((spec) => {
    assert.equal(spec, 'react')
    return fakeReact
  })
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'))

  // applying with no slots service degrades gracefully (logs, no throw) —
  // the full-render coverage lives in src/client-rig.mjs against the source.
  exports.apply({ get: () => undefined, effect: () => () => {}, interval: () => () => {}, timeout: () => () => {} })
  assert.equal(styleTags.length, 0)
})

test('每条 shell 命令都是 GNU/BSD 双兼容（macOS 回归防线）', () => {
  const source = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')

  // setsid(1) 是 util-linux 独有的，macOS 没有 —— broker 在 mac 上因此起不来，
  // 每条消息都死于 10 秒管道写超时。脱离会话必须走 node 自己的 detached:true。
  assert.ok(!/['"]setsid /.test(source), 'setsid 启动命令回来了 —— macOS 上 broker 会再次起不来')
  assert.ok(source.includes('{detached:true,stdio:"ignore"}'), 'broker 必须以 detached:true 脱离会话')

  // stat -c 是 GNU 语法；每一处都必须带 BSD 的 stat -f 兜底，否则 mac 上
  // 文件大小恒为 0（offset 兜底重放整段日志）、导入列表恒为空、broker 永不回收。
  for (const line of source.split('\n')) {
    if (!/['"$(]stat -c /.test(line)) continue
    assert.ok(line.includes('stat -f'), 'GNU-only 的 stat 调用（缺 BSD 兜底）: ' + line.trim())
  }
})
