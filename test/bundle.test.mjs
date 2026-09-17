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
  // 装配期不该真的起进程；真起了就是这里抛出来。
  const subprocess = { spawn: () => { throw new Error('装配期不该 spawn') } }
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
  // 桩服务什么都不做，但半个宿主也不该因此崩掉。
  const answer = await routes[0].handler(
    { headers: { host: '127.0.0.1:3081' }, on: (name, fn) => { if (name === 'end') fn() } },
    { writeHead() {}, end() {} },
  )
  assert.equal(answer, undefined)
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
