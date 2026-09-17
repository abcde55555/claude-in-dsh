// 引擎注册表：显示名 + 来源类型（本地 / 远程）。
//
// 这个功能的边界就是这个文件里最要紧的断言：注册表**只改显示**，能被执行的引擎
// 仍然只有 host 的 ENGINE_IDS 那三个。加一个第四种 id 是不允许的——没有对应的
// 执行路径，注册得进去只会让人以为能用。这里跑真函数，不是对着源码做正则。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const host = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = host.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  const before = host.lastIndexOf('async ', start)
  const from = before !== -1 && host.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  let i = host.indexOf('{', start)
  while (i < host.length) {
    const c = host[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < host.length && host[i] !== c) i += host[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && host[i + 1] === '/') {
      i = host.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (c === '/' && host[i + 1] === '*') {
      i = host.indexOf('*/', i) + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return host.slice(from, i + 1)
    }
    i += 1
  }
  throw new Error(`${name} 的花括号没有配平`)
}

/** 引擎 id 列表和执行层的判断，从源码里取——测试不该另抄一份。 */
function engineLiterals() {
  const ids = host.match(/const ENGINE_IDS = \[([^\]]*)\]/)
  assert.notEqual(ids, null, '找不到 ENGINE_IDS')
  const list = new Function(`return [${ids[1]}]`)()
  return { ids: list, isEngineId: (value) => typeof value === 'string' && list.indexOf(value) !== -1 }
}

/** 每个引擎能配哪些连接字段，同样从源码里取。 */
function connectionLiterals() {
  const at = host.indexOf('const AGENT_CONNECTION_FIELDS = ')
  assert.notEqual(at, -1, '找不到 AGENT_CONNECTION_FIELDS')
  const from = host.indexOf('{', at)
  let depth = 0
  for (let i = from; i < host.length; i += 1) {
    if (host[i] === '{') depth += 1
    else if (host[i] === '}') {
      depth -= 1
      if (depth === 0) return new Function(`return ${host.slice(from, i + 1)}`)()
    }
  }
  throw new Error('AGENT_CONNECTION_FIELDS 的花括号没有配平')
}

function build(file) {
  const { ids, isEngineId } = engineLiterals()
  const state = { text: file }
  const calls = { written: [], paths: [] }
  const agentsPath = '"$HOME"/.cache/ccmode/agents.json'
  // 写回注册表的那一步：这份测试只关心「写了什么、写到哪」。落盘怎么做到
  // （临时文件 + chmod 600）由别的测试管。两个名字都备着：host 内部换个函数名
  // 不该让整份测试失效。
  const record = function (target, value) {
    const single = arguments.length === 1
    calls.written.push(single ? target : value)
    calls.paths.push(single ? agentsPath : target)
    state.text = JSON.stringify(single ? target : value, null, 2) + '\n'
    return Promise.resolve()
  }
  const deps = {
    ENGINE_IDS: ids,
    isEngineId: isEngineId,
    AGENT_CONNECTION_FIELDS: connectionLiterals(),
    AGENTS_PATH: agentsPath,
    STATE_DIR: '"$HOME"/.cache/ccmode',
    AGENT_SOURCES: [
      { id: 'local', name: '本地' },
      { id: 'remote', name: '远程' },
    ],
    runCapture: (argv) => Promise.resolve(
      String(argv[2] || '').indexOf('printf %s "$HOME"') !== -1 ? '/Users/test' : state.text),
    writeAgentsFile: record,
    writeJsonFile: record,
  }
  const names = ['defaultAgents', 'readAgentsFile', 'applyAgentsEdit', 'agentsState', 'agentsEdit', 'expandHome',
    'emptyConnection', 'readConnection', 'validateConnection']
  const made = new Function('deps', `'use strict';

    const { ${Object.keys(deps).join(', ')} } = deps
    const DEFAULT_AGENT_NAMES = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex' }
    let cachedHome = null
    // readAgentsFile 会往这份缓存里写（host 里它是给同步的 connectionOf 用的）。
    let agentsCache = defaultAgents()
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, ids: ids, state: state, calls: calls }
}

/** 空串 = 不覆盖，用该引擎自己的配置；dsh 没有这一项。 */
const EMPTY_CLAUDE_CONNECTION = { baseUrl: '', apiKey: '', authToken: '' }
const EMPTY_CODEX_CONNECTION = { baseUrl: '', apiKey: '', provider: '' }

test('没有注册表文件时，三个引擎是出厂的名字 + 本地', () => {
  const rig = build('')
  return rig.agentsState().then((state) => {
    assert.deepEqual(state.agents, [
      { id: 'dsh', name: 'DSH', source: 'local', connection: null },
      { id: 'claude', name: 'Claude Code', source: 'local', connection: EMPTY_CLAUDE_CONNECTION },
      { id: 'codex', name: 'Codex', source: 'local', connection: EMPTY_CODEX_CONNECTION },
    ])
    assert.equal(state.path, '/Users/test/.cache/ccmode/agents.json')
    assert.deepEqual(state.sources, [{ id: 'local', name: '本地' }, { id: 'remote', name: '远程' }])
  })
})

test('改一个引擎的显示名和来源，另外两个原样不动', () => {
  const rig = build('')
  return rig.agentsEdit({ id: 'claude', name: 'Claude（网关）', source: 'remote' }).then((state) => {
    const written = rig.calls.written[0]
    assert.deepEqual(Object.keys(written), rig.ids, '只写认识的引擎 id')
    assert.deepEqual(written.claude, {
      name: 'Claude（网关）', source: 'remote', connection: EMPTY_CLAUDE_CONNECTION,
    })
    // dsh 连 connection 这一项都不该有：它的连接不归这份注册表管。
    assert.deepEqual(written.dsh, { name: 'DSH', source: 'local' })
    assert.deepEqual(written.codex, { name: 'Codex', source: 'local', connection: EMPTY_CODEX_CONNECTION })
    assert.equal(state.agents.find((entry) => entry.id === 'claude').name, 'Claude（网关）')
  })
})

test('不认识的引擎 id 一律拒掉，什么都不写', () => {
  // 这是这个功能的边界：注册表管显示，不管「能不能跑」。允许注册第四个 id
  // 只会让人以为它能用。
  const rig = build('')
  return ['gpt', 'gemini', 'dsh ', '', 'claude-code'].reduce((chain, id) => chain.then(() => rig
    .agentsEdit({ id: id, name: 'x', source: 'local' })
    .then(() => assert.fail('该拒绝：' + JSON.stringify(id)), (error) => {
      assert.match(error.message, /未知引擎/)
    })), Promise.resolve()).then(() => assert.equal(rig.calls.written.length, 0))
})

test('显示名不能为空、不能超长；来源只能是 local / remote', () => {
  const rig = build('')
  return rig.agentsEdit({ id: 'dsh', name: '   ', source: 'local' })
    .then(() => assert.fail('空名字该拒绝'), (error) => assert.match(error.message, /显示名不能为空/))
    .then(() => rig.agentsEdit({ id: 'dsh', name: 'x'.repeat(41), source: 'local' }))
    .then(() => assert.fail('超长该拒绝'), (error) => assert.match(error.message, /最多 40/))
    .then(() => rig.agentsEdit({ id: 'dsh', name: 'D', source: 'cloud' }))
    .then(() => assert.fail('未知来源该拒绝'), (error) => assert.match(error.message, /来源类型/))
    .then(() => assert.equal(rig.calls.written.length, 0))
})

test('写坏的行被逐个字段挑出来，不让整份注册表失效', () => {
  // 这个文件是外部输入：一行坏了最坏是那个引擎的名字难看，不该让引擎座空掉。
  const rig = build(JSON.stringify({
    dsh: { name: '  我的 DSH  ', source: 'remote' },
    claude: { name: 42, source: 'cloud' },
    codex: 'not an object',
    gpt: { name: '不该出现', source: 'local' },
  }))
  return rig.readAgentsFile().then((agents) => {
    assert.deepEqual(agents.dsh, { name: '我的 DSH', source: 'remote' }, '名字要去掉首尾空白')
    assert.deepEqual(agents.claude,
      { name: 'Claude Code', source: 'local', connection: EMPTY_CLAUDE_CONNECTION }, '两项都非法就都取出厂值')
    assert.deepEqual(agents.codex, { name: 'Codex', source: 'local', connection: EMPTY_CODEX_CONNECTION })
    assert.equal(agents.gpt, undefined, '不认识的 id 不进注册表')
  })
})

test('注册表不是合法 JSON 时静默退回出厂值', () => {
  const rig = build('{ 坏掉的')
  return rig.agentsState().then((state) => {
    assert.equal(state.agents.length, rig.ids.length)
    assert.equal(state.agents.every((entry) => entry.source === 'local'), true)
  })
})

test('写回的是三个引擎的完整注册表，路径是 agents.json', () => {
  const rig = build(JSON.stringify({ codex: { name: 'Codex（远程）', source: 'remote' } }))
  return rig.agentsEdit({ id: 'dsh', name: 'DSH 本机', source: 'local' }).then(() => {
    assert.equal(rig.calls.paths[0], '"$HOME"/.cache/ccmode/agents.json')
    assert.equal(rig.calls.written[0].codex.name, 'Codex（远程）', '别把别人改过的名字覆盖掉')
  })
})

test('执行层的引擎判断没被这份注册表动过', () => {
  // isEngineId 的语义不变：它只认 ENGINE_IDS。注册表再怎么写都进不到这里。
  const { ids, isEngineId } = engineLiterals()
  assert.deepEqual(ids, ['dsh', 'claude', 'codex'])
  assert.equal(isEngineId('dsh'), true)
  assert.equal(isEngineId('gpt'), false)
})

// ---- 连接配置：这一栏的语义是「空串 = 不覆盖」 ----

test('不传 connection 时，原有的连接配置一个字节都不动', () => {
  // 这条最要紧：老的调用方只传 id/name/source。多了这一栏之后，**传 connection
  // 是整个替换、不传是保持原样**——两者语义不同，别把前者当默认。
  const rig = build(JSON.stringify({
    claude: { name: 'Claude', source: 'local', connection: { baseUrl: 'https://gw.example.com', apiKey: 'sk-x', authToken: '' } },
    codex: { name: 'Codex', source: 'local', connection: { baseUrl: 'https://codex.example.com', apiKey: '', provider: 'my-gw' } },
  }))
  return rig.agentsEdit({ id: 'claude', name: 'Claude（改名）', source: 'remote' }).then(() => {
    const written = rig.calls.written[0]
    assert.deepEqual(written.claude.connection,
      { baseUrl: 'https://gw.example.com', apiKey: 'sk-x', authToken: '' }, '不传 connection：原样保留')
    assert.deepEqual(written.codex.connection,
      { baseUrl: 'https://codex.example.com', apiKey: '', provider: 'my-gw' }, '别的引擎的连接也不能被顺手冲掉')
  })
})

test('传了 connection 就整个替换，空串 = 回到「不覆盖」', () => {
  const rig = build(JSON.stringify({
    claude: { name: 'Claude', source: 'local', connection: { baseUrl: 'https://old.example.com', apiKey: 'sk-old', authToken: 'tok-old' } },
  }))
  return rig.agentsEdit({
    id: 'claude', name: 'Claude', source: 'local',
    connection: { baseUrl: 'https://new.example.com', apiKey: '', authToken: '' },
  }).then((state) => {
    const expected = { baseUrl: 'https://new.example.com', apiKey: '', authToken: '' }
    assert.deepEqual(rig.calls.written[0].claude.connection, expected, '没填的字段跟着回到空串，不是保留旧值')
    assert.deepEqual(state.agents.find((entry) => entry.id === 'claude').connection, expected)
  })
})

test('dsh 没有连接字段：给它 connection 会被拒，什么都不写', () => {
  // dsh 的模型和连接归 dsh 自己那套设置管（客户端那一栏也不渲染）。UI 不传是
  // 前端的事，host 这一侧同样得挡住 —— 两条路各自守住自己的边界。
  const rig = build('')
  return rig.agentsEdit({ id: 'dsh', name: 'DSH', source: 'local', connection: { baseUrl: 'https://x.example.com' } })
    .then(() => assert.fail('dsh 不该有连接字段'), (error) => assert.match(error.message, /没有可配的连接字段/))
    .then(() => assert.equal(rig.calls.written.length, 0))
})

test('连接字段的坏值被挑出来，不写坏注册表', () => {
  const rig = build('')
  return rig.agentsEdit({ id: 'codex', name: 'Codex', source: 'local', connection: { baseUrl: 'https://ok.example.com', provider: 42 } })
    .then(() => assert.fail('类型不对该拒绝'), (error) => assert.match(error.message, /provider 必须是字符串/))
    .then(() => rig.agentsEdit({ id: 'codex', name: 'Codex', source: 'local', connection: { apiKey: 'x'.repeat(501) } }))
    .then(() => assert.fail('超长该拒绝'), (error) => assert.match(error.message, /apiKey 太长了/))
    .then(() => assert.equal(rig.calls.written.length, 0))
})

test('agents.json 里写坏的连接配置只丢那一个字段，别的照读', () => {
  // agents.json 是外部输入（手写、别的版本写的）：一份写坏的连接配置最坏只该让
  // 那个引擎退回「用自己配置」，不该让整份注册表读不出来。
  const rig = build(JSON.stringify({
    claude: { name: 'Claude', source: 'local', connection: { baseUrl: 42, apiKey: '  sk-keep  ', authToken: null } },
    codex: { name: 'Codex', source: 'local', connection: 'not an object' },
    dsh: { name: 'DSH', source: 'local', connection: { baseUrl: 'https://ignored.example.com' } },
  }))
  return rig.readAgentsFile().then((agents) => {
    assert.deepEqual(agents.claude.connection, { baseUrl: '', apiKey: 'sk-keep', authToken: '' },
      '坏字段丢、好字段留、首尾空白去掉')
    assert.deepEqual(agents.codex.connection, EMPTY_CODEX_CONNECTION, '整个不是对象就当没配')
    assert.equal(agents.dsh.connection, undefined, 'dsh 连这一项都不该有')
  })
})

test('agentsState 里 dsh 的 connection 是 null —— 客户端据此不画那一栏', () => {
  const rig = build('')
  return rig.agentsState().then((state) => {
    const byId = {}
    for (const entry of state.agents) byId[entry.id] = entry
    assert.equal(byId.dsh.connection, null)
    assert.deepEqual(byId.claude.connection, EMPTY_CLAUDE_CONNECTION)
    assert.deepEqual(byId.codex.connection, EMPTY_CODEX_CONNECTION)
  })
})

// ---- 客户端那半：每个显示引擎名的地方都读同一份注册表 ----

const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

/** 切出取名的三个函数，注入一份注册表缓存（就是它们平时读的那个变量）。 */
function clientNames(cache) {
  const start = client.indexOf('    function agentOf(id) {')
  const end = client.indexOf('    function refreshAgents()')
  assert.ok(start > 0 && end > start, '取名函数搬走了')
  const factory = client.match(/const FALLBACK_AGENT_NAMES = (\{[^}]*\})/)
  assert.notEqual(factory, null, '找不到 FALLBACK_AGENT_NAMES')
  const fallback = new Function(`return ${factory[1]}`)()
  const make = new Function('agents', 'FALLBACK_AGENT_NAMES',
    client.slice(start, end) + '; return { agentOf, engineName, sourceLabel }')
  return make(cache, fallback)
}

test('显示名与来源都来自注册表', () => {
  const names = clientNames({ claude: { id: 'claude', name: 'Claude（网关）', source: 'remote' } })
  assert.equal(names.engineName('claude'), 'Claude（网关）')
  assert.equal(names.sourceLabel('claude'), '远程')
  assert.equal(names.engineName('codex'), 'Codex', '注册表里没有的引擎取出厂名')
  assert.equal(names.sourceLabel('codex'), '本地')
  assert.equal(names.engineName('dsh'), 'DSH')
})

test('host 还没应答时先用出厂名画出来，而不是空白', () => {
  // 座位在 catalog/agents 应答之前就要画第一帧。
  const names = clientNames({})
  assert.deepEqual(['dsh', 'claude', 'codex'].map(names.engineName), ['DSH', 'Claude Code', 'Codex'])
  assert.deepEqual(['dsh', 'claude', 'codex'].map(names.sourceLabel), ['本地', '本地', '本地'])
})
