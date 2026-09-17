// Offline rig for the client half: evaluates it exactly the way the browser
// runner does (same closure parameters), then renders every component it seats
// with realistic props. A reference error or a bad hook call fails here instead
// of silently abdicating a slot entry in the page.

import fs from 'node:fs'

const source = fs.readFileSync(new URL('./client.dynamic.js', import.meta.url), 'utf8')

// ---- a React stand-in with just enough hook behaviour -----------------------
let hookCells = []
let hookIndex = 0
const effects = []

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState(initial) {
    const at = hookIndex++
    if (!(at in hookCells)) hookCells[at] = typeof initial === 'function' ? initial() : initial
    return [hookCells[at], (next) => { hookCells[at] = typeof next === 'function' ? next(hookCells[at]) : next }]
  },
  useEffect(fn, deps) { effects.push(fn) },
  useRef(initial) {
    const at = hookIndex++
    if (!(at in hookCells)) hookCells[at] = { current: initial }
    return hookCells[at]
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
}

const styles = { insert: (css) => { if (typeof css !== 'string') throw new Error('styles.insert needs a string') } }

// 引擎注册表的桩数据：agents.get / agents.set 都从这里取，形状与 host 一致。
// connection 是引擎节新增的那一栏 —— dsh 是 null（那一栏不渲染），另两个各带自己
// 的字段。claude 故意给非空值，好断言「host 存着的值真的画出来了」。
const rigAgents = [
  { id: 'dsh', name: 'DSH', source: 'local', connection: null },
  { id: 'claude', name: 'Claude（网关）', source: 'remote', connection: { baseUrl: 'https://gw.example.com', apiKey: 'sk-rig-secret', authToken: '' } },
  { id: 'codex', name: 'Codex', source: 'local', connection: { baseUrl: '', apiKey: '', provider: '' } },
]
const rigAgentsState = () => ({
  path: '/Users/rig/.cache/ccmode/agents.json',
  sources: [{ id: 'local', name: '本地' }, { id: 'remote', name: '远程' }],
  agents: rigAgents.map((entry) => Object.assign({}, entry, {
    connection: entry.connection === null ? null : Object.assign({}, entry.connection),
  })),
})

const hostCalls = []
const host = {
  call: (method, args) => {
    // 记下参数而不只是方法名：引擎节「没动过的连接配置不该回传」这条断言要读它。
    hostCalls.push({ method: method, args: args })
    if (method === 'catalog') {
      // 故意造出「当前模型被隐藏」的局面：它在 models（菜单列的那份）里没有，
      // 只在 allModels（命名那份）里。见下面 hidden model 那条断言。
      return Promise.resolve({
        models: [{ id: '', name: 'default', reasoning: false }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true }],
        allModels: [
          { id: '', name: 'default', reasoning: false },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true },
          { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: true },
        ],
        efforts: [{ id: '', name: 'default' }, { id: 'high', name: 'high' }],
        permissionModes: [{ id: 'manual', name: 'manual', detail: 'ask' }, { id: 'acceptEdits', name: 'acceptEdits', detail: 'edits' }],
      })
    }
    if (method === 'state.get') {
      return Promise.resolve({ mode: 'claude', permissionMode: 'manual', model: 'claude-opus-4-5', route: 'claude-opus-4-5', effort: 'high', running: true, committed: 'claude', locked: true })
    }
    if (method === 'commands') {
      return Promise.resolve({ commands: ['deep-research', 'verify', 'code-review', 'compact', 'usage'] })
    }
    if (method === 'engines') {
      return Promise.resolve({ engines: { 'session-11111111-2222-4333-8444-555555555555': 'claude', 'session-99999999-8888-4777-8666-555555555555': 'dsh' } })
    }
    // 设置面板那两节：给一份和 host 同形状的答案，好让它们真的渲染出内容
    // （返回 {} 会让它们停在「正在读取…」，那就什么都没验到）。
    if (method === 'models.get') {
      return Promise.resolve({
        path: '/Users/rig/.cache/ccmode/models.json',
        models: [
          { id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true, builtin: true, hidden: false },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, builtin: true, hidden: true },
          { id: 'glm-5', name: 'GLM 5', reasoning: true, builtin: false, hidden: false },
        ],
        defaults: { claude: 'claude-opus-5', codex: '' },
      })
    }
    if (method === 'agents.get') {
      return Promise.resolve(rigAgentsState())
    }
    if (method === 'agents.set') {
      // 和 host 一样：改完返回整份 state；**不传 connection 就保持原样** ——
      // 老的调用方（只传 id/name/source）不能被弄坏。
      const at = rigAgents.findIndex((entry) => entry.id === args.id)
      if (at !== -1) {
        rigAgents[at].name = args.name
        rigAgents[at].source = args.source
        if (args.connection !== undefined) rigAgents[at].connection = args.connection
      }
      return Promise.resolve(rigAgentsState())
    }
    if (method === 'usage') {
      return Promise.resolve({
        official: true, subscription: 'max',
        windows: [
          { id: 'five_hour', label: '5h', utilization: 35, resetsAt: new Date(Date.now() + 4 * 3600e3).toISOString() },
          { id: 'seven_day', label: '7d', utilization: 22, resetsAt: new Date(Date.now() + 30 * 3600e3).toISOString() },
        ],
        fetchedAt: Date.now(),
      })
    }
    return Promise.resolve({})
  },
}
const harness = {}

// ---- a slots service that records what gets seated -------------------------
const seated = []
const slots = {
  inject: (name, factory) => {
    const value = factory()
    if (value && typeof value.next === 'function') { let step = value.next(); while (!step.done) step = value.next() }
    return () => {}
  },
  register: (options, component) => { seated.push({ options, component }); return () => {} },
  spec: () => ({ kind: 'list', scope: 'session' }),
}

const registeredCommands = []
const commandUi = { register: (c) => { registeredCommands.push(c.name); return () => {} } }
const sessionsService = { binding: () => ({ session: { prompt: async () => true } }), create: async () => 'session-new', open: () => {} }

const ctx = {
  get: (name) => (name === 'slots' ? slots : name === 'commandUi' ? commandUi : name === 'sessions' ? sessionsService : undefined),
  interval: (fn, ms) => { if (typeof fn !== 'function') throw new Error('ctx.interval needs a function'); return () => {} },
  timeout: (fn, ms) => () => {},
  effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
}

// a DOM stand-in with two sidebar rows, one of them a Claude session
function fakeEl(className, sessionId) {
  const el = {
    className, children: [], parentNode: null,
    getElementsByClassName(name) { return el.children.filter((c) => c.className === name) },
    insertBefore(node, ref) { node.parentNode = el; el.children.unshift(node) },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el) },
    get firstChild() { return el.children[0] },
    title: '', textContent: '',
  }
  if (sessionId !== undefined) {
    // mirrors the shipped shape: div → span → Tooltip → SessionNodeItem({node, currentId})
    const itemFiber = { memoizedProps: { node: { kind: 'session', row: { sessionId, title: 't' } }, currentId: 'session-selected' }, return: null }
    el['__reactFiber$rig'] = { memoizedProps: { className: 'row' }, return: { memoizedProps: {}, return: itemFiber } }
  }
  return el
}
const claudeRow = fakeEl('YDXeBa_sessionRow', 'session-11111111-2222-4333-8444-555555555555')
claudeRow.children.push(fakeEl('YDXeBa_title'))
const dshRow = fakeEl('YDXeBa_sessionRow', 'session-99999999-8888-4777-8666-555555555555')
dshRow.children.push(fakeEl('YDXeBa_title'))
const rows = [claudeRow, dshRow]

globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.Element = class {}
globalThis.document = {
  body: { setAttribute() {}, removeAttribute() {} },
  addEventListener() {}, removeEventListener() {},
  getElementsByClassName(name) {
    if (name === 'YDXeBa_sessionRow') return rows
    return rows.flatMap((r) => r.getElementsByClassName(name))
  },
  querySelectorAll: () => rows,
  createElement: () => fakeEl(''),
  querySelectorAll: () => rows,
}

const closure = new Function('React', 'console', 'styles', 'host', 'harness', `return (async () => {\n${source}\n})()`)
const plugin = await closure(React, console, styles, host, harness)
if (typeof plugin.apply !== 'function') throw new Error('client half returned no apply')
plugin.apply(ctx)

console.log('inject declared:', JSON.stringify(plugin.inject))
console.log('seats:', seated.map((s) => s.options.name + (s.options.id ? '#' + s.options.id : '') + (s.options.key ? ':' + s.options.key : '')).join(', ').slice(0, 400))

// ---- render every seated component with plausible props --------------------
/**
 * 递归展开函数组件。
 *
 * 早先这里只调用**顶层**组件的函数体 —— `h()` 桩不递归，所以任何只经由嵌套
 * `h(<Component>)` 到达的代码（这个插件里就是那三处共享的下拉座位）从来没被
 * 执行过。那会让 `ALL COMPONENTS RENDER` 读起来像「客户端半边有覆盖」，而实测
 * 往嵌套组件里注入一个必然的 ReferenceError，它照样报全绿。
 *
 * 只关心「会不会抛」，所以不重建树，就地展开。
 */
function expand(node, depth) {
  if (depth > 80) throw new Error('组件递归超过 80 层（自引用？）')
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const child of node) expand(child, depth)
    return node
  }
  const kids = node.children === undefined
    ? []
    : (Array.isArray(node.children) ? node.children : [node.children])
  if (typeof node.type === 'function') {
    // 函数组件：真的调一次，再展开它返回的东西。
    expand(node.type({ ...node.props, children: kids.length <= 1 ? kids[0] : kids }), depth + 1)
  } else {
    for (const kid of kids) expand(kid, depth)
  }
  return node
}

/** 在渲染出来的树里找 chip 上那行字（trigger 的 label）。 */
function labelText(node, depth) {
  const d = depth || 0
  if (d > 300 || node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = labelText(child, d + 1); if (hit !== null) return hit }
    return null
  }
  const kids = node.children === undefined ? [] : (Array.isArray(node.children) ? node.children : [node.children])
  const cls = node.props && node.props.className
  if (typeof cls === 'string' && cls.indexOf('triggerLabel') !== -1) {
    for (const kid of kids) if (typeof kid === 'string') return kid
    return ''
  }
  for (const kid of kids) { const hit = labelText(kid, d + 1); if (hit !== null) return hit }
  return null
}

const kidsOf = (node) => (node.children === undefined
  ? []
  : (Array.isArray(node.children) ? node.children : [node.children]))

/** 在渲染树里收集所有满足条件的节点（含自身，深度优先）。 */
function collect(node, hit, found) {
  const out = found || []
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, hit, out)
    return out
  }
  if (node.props !== undefined && hit(node)) out.push(node)
  for (const kid of kidsOf(node)) collect(kid, hit, out)
  return out
}

/** 树里所有字符串叶子 —— 用来断言某句说明真的画在了界面上，而不是只存在于源码里。 */
function textOf(node, out) {
  const acc = out || []
  if (typeof node === 'string') { acc.push(node); return acc }
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, acc)
    return acc
  }
  for (const kid of kidsOf(node)) textOf(kid, acc)
  return acc
}

/** 引擎节的一行是哪个引擎：认它那行「显示名 · <id>」标签，比认 key 稳。 */
function rowId(row) {
  const labels = collect(row, (node) => typeof node.props.className === 'string'
    && node.props.className.indexOf('ccmode-set-field-label') !== -1)
  for (const label of labels) {
    for (const kid of kidsOf(label)) {
      if (typeof kid === 'string' && kid.indexOf('显示名 · ') === 0) return kid.slice('显示名 · '.length)
    }
  }
  return null
}

/** 一行里某个字段的输入框：按它头上那行标签认。 */
function fieldInput(row, label) {
  const fields = collect(row, (node) => node.props.className === 'ccmode-set-field')
  for (const field of fields) {
    const head = collect(field, (node) => typeof node.props.className === 'string'
      && node.props.className.indexOf('ccmode-set-field-label') !== -1)[0]
    if (head !== undefined && textOf(head)[0] === label) return collect(field, (node) => node.type === 'input')[0]
  }
  return undefined
}

/** 一行里的某个按钮（按按钮上那行字认）。 */
function rowButton(row, text) {
  return collect(row, (node) => node.type === 'button' && textOf(node)[0] === text)[0]
}

function render(component, props, label) {
  hookCells = []
  hookIndex = 0
  effects.length = 0
  const tree = component(props)
  // 先展开（嵌套组件的 effect 也在这一步里收集），再统一跑 effect ——
  // 顺序和 React 不同，但这里只要「都执行过」。
  expand(tree, 0)
  for (const fn of effects) { const cleanup = fn(); if (typeof cleanup === 'function') cleanup() }
  return tree
}

const sessionProps = { sessionId: 'session-11111111-2222-4333-8444-555555555555' }
const runningCall = { callId: 'toolu_1', name: 'Bash', argsRaw: JSON.stringify({ command: 'echo hi', description: 'd' }), subCalls: [] }
const settledCall = {
  kind: 'tool-result', callId: 'toolu_1', call: { name: 'Edit', argsRaw: JSON.stringify({ file_path: '/a/b.txt', old_string: 'x', new_string: 'y' }) },
  content: [{ type: 'text', text: 'done' }], isError: false, subCalls: [],
}
const failedCall = {
  kind: 'tool-result', callId: 'toolu_2', call: { name: 'Write', argsRaw: JSON.stringify({ file_path: '/a/b.txt', content: 'hello' }) },
  content: [{ type: 'text', text: '<tool_use_error>File has not been read yet. Read it first.</tool_use_error>' }], isError: true, subCalls: [],
}

let failures = 0
for (const seat of seated) {
  const isTool = seat.options.name === 'tool.call.toolview'
  const cases = isTool
    ? [
        ['running', { ...sessionProps, toolName: seat.options.key, block: { ...runningCall, name: seat.options.key } }],
        ['settled', { ...sessionProps, toolName: seat.options.key, block: settledCall }],
        ['failed', { ...sessionProps, toolName: seat.options.key, block: failedCall }],
      ]
    : [['default', sessionProps]]
  for (const [label, props] of cases) {
    try {
      render(seat.component, props, label)
    } catch (error) {
      failures += 1
      console.log('RENDER FAILURE', seat.options.name, seat.options.key || seat.options.id, label, '→', error.message)
    }
  }
}

// the seats acquired only while Claude drives are registered lazily; force them.
// 但必须先等 load() 落地：在此之前 stateOf 还是兜底的 dsh，引擎座的 effect 不会
// 调 acquireShadow，影子座一个都注册不上 —— 这个台架此前一直报 «(none)»，
// 意味着模型座、权限档座、图片轨这三块从来没被渲染过。
await new Promise((r) => setTimeout(r, 50))
const before = seated.length
const engine = seated.find((s) => s.options.id === 'ccmode-engine')
if (engine !== undefined) {
  hookCells = []; hookIndex = 0; effects.length = 0
  engine.component({ ...sessionProps })
  for (const fn of effects) fn()
  console.log('shadow seats after claude mode:', seated.slice(before).map((s) => s.options.name + (s.options.id ? '#' + s.options.id : '')).join(', ') || '(none)')
  for (const seat of seated.slice(before)) {
    try { render(seat.component, sessionProps, 'shadow') } catch (error) {
      failures += 1
      console.log('RENDER FAILURE', seat.options.name, seat.options.id, '→', error.message)
    }
  }
}

// ---- 被隐藏的模型仍该显示名字，而不是原始 id ----
// 场景：会话正跑在 claude-opus-4-5 上，用户随后把它隐藏了 —— 菜单里不再列它，
// 于是它只存在于 catalog.allModels。命名若去查菜单那份（models），chip 就会退成
// 原始 id「claude-opus-4-5」，而不是「Claude Opus 4.5」。隐藏是「不再列出来」，
// 不是「假装它不存在」：正跑在上面的会话仍该看得懂自己跑的是什么。
{
  const modelSeat = seated.find((s) => s.options.name === 'conversation.input.model')
  if (modelSeat === undefined) {
    failures += 1
    console.log('HIDDEN MODEL: 模型座没注册上 —— 这条断言失去意义，别当成通过')
  } else {
    const shown = labelText(render(modelSeat.component, sessionProps, 'hidden-model'))
    if (shown !== 'Claude Opus 4.5') {
      failures += 1
      console.log('HIDDEN MODEL LABEL FAILURE →', JSON.stringify(shown), '（应为 "Claude Opus 4.5"）')
    } else {
      console.log('hidden model label:', JSON.stringify(shown))
    }
  }
}

await new Promise((r) => setTimeout(r, 50))
const badged = rows.map((row) => row.getElementsByClassName('ccmode-row-badge').length)
console.log('sidebar badges [claude row, dsh row]:', JSON.stringify(badged))
if (badged[0] !== 1 || badged[1] !== 0) { failures += 1; console.log('BADGE FAILURE') }

await new Promise((r) => setTimeout(r, 30))
console.log('claude commands registered:', registeredCommands.length, registeredCommands.slice(0, 4).join(','))

// ---- 引擎节的连接字段 ----
// 这一节要等 agents.get 落地才有内容：第一帧 state 还是 null，画的只是「正在读取
// 引擎注册表…」。台架别处的 render() 每次都清 hook cell，这一节就永远停在加载态，
// 断言会绿得毫无意义 —— 所以这里自己逐帧重画：hookIndex 归零、hookCells 留着，
// setState 写进去的值下一帧就看得见。
{
  const check = (ok, message) => {
    if (!ok) { failures += 1; console.log('AGENT CONNECTION FAILURE →', message) }
  }
  const seat = seated.find((s) => s.options.id === 'ccmode-agents')
  try {
  if (seat === undefined) {
    check(false, '引擎节没注册上 —— 这条断言失去意义，别当成通过')
  } else {
    const paint = () => {
      hookIndex = 0
      effects.length = 0
      const tree = seat.component({})
      expand(tree, 0)
      for (const fn of effects) fn()
      return tree
    }
    const rowIn = (tree, id) => collect(tree, (node) => node.props.className === 'ccmode-set-row')
      .find((row) => rowId(row) === id)
    const inputsOf = (row) => collect(row, (node) => node.type === 'input')
    const masked = (row) => inputsOf(row).filter((node) => node.props.type === 'password').length

    hookCells = []
    paint()
    await new Promise((r) => setTimeout(r, 20))
    const tree = paint()
    const rowsNow = collect(tree, (node) => node.props.className === 'ccmode-set-row')
    const dsh = rowIn(tree, 'dsh')
    const claude = rowIn(tree, 'claude')
    const codex = rowIn(tree, 'codex')

    check(rowsNow.length === 3 && dsh !== undefined && claude !== undefined && codex !== undefined,
      '三行引擎没画齐：' + JSON.stringify(rowsNow.map(rowId)))
    if (dsh !== undefined && claude !== undefined && codex !== undefined) {
      // dsh 的模型和连接归 dsh 自己那套设置管：这一栏只能有「显示名」一个输入框。
      check(inputsOf(dsh).length === 1, 'dsh 那栏不该有连接字段，实际 ' + inputsOf(dsh).length + ' 个输入框')
      check(inputsOf(claude).length === 4, 'claude 该有 显示名 + baseUrl/apiKey/authToken 四个输入框，实际 ' + inputsOf(claude).length)
      check(inputsOf(codex).length === 4, 'codex 该有 显示名 + baseUrl/apiKey/provider 四个输入框，实际 ' + inputsOf(codex).length)

      check(fieldInput(claude, 'Base URL').props.value === 'https://gw.example.com', 'host 存着的 baseUrl 没画出来')
      check(fieldInput(claude, 'Auth Token').props.value === '', '空串该画成空输入框')
      check(masked(claude) === 2, 'claude 的 apiKey / authToken 默认该遮着，实际遮了 ' + masked(claude))
      check(masked(codex) === 1, 'codex 的 apiKey 默认该遮着，实际遮了 ' + masked(codex))

      // 「留空 = 用该引擎自己的配置」得是看得见的字，不能只活在源码里。
      const claudeText = textOf(claude).join('')
      const codexText = textOf(codex).join('')
      check(claudeText.indexOf('settings.json') !== -1, 'claude 的「留空 = 读哪份配置」没画出来')
      check(codexText.indexOf('model_provider') !== -1 && codexText.indexOf('wire_api') !== -1,
        'codex 的 provider 说明（跟随 model_provider、保留 wire_api / http_headers）没画出来')

      // 「显示」开关：点开一个只解开一个，别的照旧遮着。
      const toggles = collect(claude, (node) => node.type === 'button' && textOf(node)[0] === '显示')
      check(toggles.length === 2, 'claude 该有两个「显示」开关，实际 ' + toggles.length)
      if (toggles.length === 2) {
        toggles[0].props.onClick()
        const after = rowIn(paint(), 'claude')
        check(masked(after) === 1, '点开一个「显示」只该解开一个字段，实际剩 ' + masked(after) + ' 个遮着')
      }

      // 只改名字：连接配置一个字节都不该回传 —— 老的调用方不能被弄坏，
      // 读回来的 key 也没必要在桥上跑一圈。
      const first = hostCalls.length
      fieldInput(claude, '显示名 · claude').props.onChange({ target: { value: 'Claude（自建）' } })
      const dirtyRow = rowIn(paint(), 'claude')
      const saveButton = rowButton(dirtyRow, '保存')
      check(saveButton.props.disabled === false, '改过名字之后「保存」该是可点的')
      saveButton.props.onClick()
      const sets = hostCalls.slice(first).filter((entry) => entry.method === 'agents.set')
      check(sets.length === 1, '点一次保存该发一次 agents.set，实际 ' + sets.length)
      if (sets.length === 1) {
        check(sets[0].args.connection === undefined, '只改了名字，连接配置不该回传：' + JSON.stringify(sets[0].args))
        check(sets[0].args.source === 'remote', '只碰了名字，来源也得照原样带上（整份草稿就是为此）')
      }
      await new Promise((r) => setTimeout(r, 20))
      const tail = hostCalls.slice(first).map((entry) => entry.method)
      const setAt = tail.indexOf('agents.set')
      check(setAt !== -1 && tail.slice(setAt + 1).indexOf('agents.get') !== -1, '保存后没重读注册表：' + JSON.stringify(tail))
      const refreshed = rowIn(paint(), 'claude')
      check(fieldInput(refreshed, '显示名 · claude').props.value === 'Claude（自建）', '保存后界面停在旧值')

      // 改过连接才回传，且整份替换。
      const second = hostCalls.length
      fieldInput(refreshed, 'Base URL').props.onChange({ target: { value: 'https://new.example.com' } })
      const connRow = rowIn(paint(), 'claude')
      check(rowButton(connRow, '保存').props.disabled === false, '改过连接之后「保存」该是可点的')
      rowButton(connRow, '保存').props.onClick()
      const connSet = hostCalls.slice(second).filter((entry) => entry.method === 'agents.set')[0]
      check(connSet !== undefined && connSet.args.connection !== undefined, '改过连接就该整份回传')
      if (connSet !== undefined && connSet.args.connection !== undefined) {
        check(connSet.args.connection.baseUrl === 'https://new.example.com', '新的 baseUrl 没带上')
        check(connSet.args.connection.apiKey === 'sk-rig-secret', '没碰的字段也得整份带上（整个替换的语义）')
      }
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  // 断言里的异常（比如 host 那份 connection 变了形状）要记成一处失败并说清是哪条，
  // 而不是把整个台架连栈一起掀掉 —— 后面还有别的断言要跑。
  } catch (error) {
    check(false, '抛异常：' + (error && error.message ? error.message : String(error)))
  }
}

console.log(failures === 0 ? 'ALL COMPONENTS RENDER' : failures + ' RENDER FAILURES')
process.exit(failures === 0 ? 0 : 1)
