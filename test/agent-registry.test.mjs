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

function build(file) {
  const { ids, isEngineId } = engineLiterals()
  const state = { text: file }
  const calls = { written: [], paths: [] }
  const deps = {
    ENGINE_IDS: ids,
    isEngineId: isEngineId,
    AGENTS_PATH: '"$HOME"/.cache/ccmode/agents.json',
    STATE_DIR: '"$HOME"/.cache/ccmode',
    AGENT_SOURCES: [
      { id: 'local', name: '本地' },
      { id: 'remote', name: '远程' },
    ],
    runCapture: (argv) => Promise.resolve(
      String(argv[2] || '').indexOf('printf %s "$HOME"') !== -1 ? '/Users/test' : state.text),
    writeJsonFile: (target, value) => {
      calls.written.push(value)
      calls.paths.push(target)
      state.text = JSON.stringify(value, null, 2) + '\n'
      return Promise.resolve()
    },
  }
  const names = ['defaultAgents', 'readAgentsFile', 'applyAgentsEdit', 'agentsState', 'agentsEdit', 'expandHome']
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    const DEFAULT_AGENT_NAMES = { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex' }
    let cachedHome = null
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, ids: ids, state: state, calls: calls }
}

test('没有注册表文件时，三个引擎是出厂的名字 + 本地', () => {
  const rig = build('')
  return rig.agentsState().then((state) => {
    assert.deepEqual(state.agents, [
      { id: 'dsh', name: 'DSH', source: 'local' },
      { id: 'claude', name: 'Claude Code', source: 'local' },
      { id: 'codex', name: 'Codex', source: 'local' },
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
    assert.deepEqual(written.claude, { name: 'Claude（网关）', source: 'remote' })
    assert.deepEqual(written.dsh, { name: 'DSH', source: 'local' })
    assert.deepEqual(written.codex, { name: 'Codex', source: 'local' })
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
    assert.deepEqual(agents.claude, { name: 'Claude Code', source: 'local' }, '两项都非法就都取出厂值')
    assert.deepEqual(agents.codex, { name: 'Codex', source: 'local' })
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
