// 新对话开在「上一次选定的那套配置」上：引擎（dsh/Claude）、权限档、模型、
// effort。此前每个新会话都从硬编码的 DSH + manual + 默认模型开始，选一次
// Claude 就得再切一次。
//
// 这里跑的是真函数，不是对着源码做正则——stateOf 的初值和 rememberDefaults
// 的写入条件是这个特性的全部行为。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  let i = source.indexOf('{', start)
  while (i < source.length) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
    i += 1
  }
  throw new Error(`${name} 的花括号没有配平`)
}

/** 出厂默认那一行，从源码里取，免得测试和实现各写一份。 */
function factoryDefaults() {
  const line = source.match(/const defaults = (\{[^}]*\})/)
  assert.notEqual(line, null, '找不到 defaults 的出厂值')
  return new Function('DEFAULT_MODEL', 'DEFAULT_CODEX_SANDBOX', `return ${line[1]}`)('claude-opus-5', 'workspace-write')
}

function build() {
  const calls = { persisted: 0 }
  const deps = {
    DEFAULT_MODEL: 'claude-opus-5',
    // stateOf 的初值里有 Codex 的沙箱档，所以这一份依赖也得给。
    DEFAULT_CODEX_SANDBOX: 'workspace-write',
    states: new Map(),
    defaults: factoryDefaults(),
    persistStates: () => { calls.persisted += 1 },
    // 会话日志说了算的那条路单独测；这里只看「什么都不知道」时的开局。
    committedEngine: () => undefined,
  }
  const names = ['stateOf', 'rememberDefaults', 'rememberCodexSandbox', 'defaultModelFor']
  const made = new Function('deps', `'use strict';

    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, defaults: deps.defaults, states: deps.states, calls: calls }
}

test('什么都没选过：新会话是 DSH', () => {
  const rig = build()
  const state = rig.stateOf('s1')
  assert.equal(state.mode, 'dsh')
  assert.equal(state.permissionMode, 'manual')
  assert.equal(state.model, 'claude-opus-5')
  // Codex 的两栏同样有出厂值：没有 thread（全新对话）、沙箱落在工作区内可写。
  assert.equal(state.codexThreadId, undefined)
  assert.equal(state.codexSandbox, 'workspace-write')
})

test('选过 Claude 之后，新会话直接是 Claude', () => {
  const rig = build()
  const first = rig.stateOf('s1')
  first.mode = 'claude'
  first.permissionMode = 'bypassPermissions'
  first.model = 'claude-sonnet-5'
  first.effort = 'high'
  rig.rememberDefaults(first)

  const fresh = rig.stateOf('s2')
  assert.equal(fresh.mode, 'claude', '否则每开一个新对话都要再切一次引擎')
  assert.equal(fresh.permissionMode, 'bypassPermissions')
  assert.equal(fresh.model, 'claude-sonnet-5')
  assert.equal(fresh.effort, 'high')
})

test('改回 DSH 之后，新会话也跟着回 DSH', () => {
  const rig = build()
  const a = rig.stateOf('s1')
  a.mode = 'claude'
  rig.rememberDefaults(a)
  const b = rig.stateOf('s2')
  b.mode = 'dsh'
  rig.rememberDefaults(b)
  assert.equal(rig.stateOf('s3').mode, 'dsh', '记的是最后一次选择，不是「用过 Claude 就永远 Claude」')
})

test('已经存在的会话不受后来的选择影响', () => {
  const rig = build()
  const old = rig.stateOf('s1')
  assert.equal(old.mode, 'dsh')
  const other = rig.stateOf('s2')
  other.mode = 'claude'
  other.model = 'claude-sonnet-5'
  rig.rememberDefaults(other)
  assert.equal(rig.stateOf('s1').mode, 'dsh', '默认只管新会话的开局，不该回头改已有的')
  assert.equal(rig.stateOf('s1').model, 'claude-opus-5')
})

test('选择没有变化就不落盘', () => {
  const rig = build()
  const state = rig.stateOf('s1')
  rig.rememberDefaults(state)
  assert.equal(rig.calls.persisted, 0, '每次点开菜单都写一次盘，纯属浪费')
  state.mode = 'claude'
  rig.rememberDefaults(state)
  assert.equal(rig.calls.persisted, 1)
  rig.rememberDefaults(state)
  assert.equal(rig.calls.persisted, 1, '同样的选择重复提交，不该再写')
})

test('effort 也跟着记', () => {
  const rig = build()
  const state = rig.stateOf('s1')
  state.effort = 'high'
  rig.rememberDefaults(state)
  assert.equal(rig.stateOf('s2').effort, 'high')
})

test('Codex 的沙箱单独记：选它不会顺手覆写 Claude 的档位', () => {
  const rig = build()
  const state = rig.stateOf('s1')
  state.mode = 'codex'
  state.codexSandbox = 'danger-full-access'
  rig.rememberCodexSandbox(state)
  // Claude 那四栏一个都没动 —— 这正是它不复用 rememberDefaults 的理由。
  assert.equal(rig.calls.persisted, 1)
  assert.equal(rig.defaults.permissionMode, 'manual')
  assert.equal(rig.defaults.model, 'claude-opus-5')

  const fresh = rig.stateOf('s2')
  assert.equal(fresh.codexSandbox, 'danger-full-access', '新会话开在上一次选定的沙箱上')
  // 同一个值重复提交不再写盘。
  rig.rememberCodexSandbox(state)
  assert.equal(rig.calls.persisted, 1)
})

test('Codex 会话里选的模型不动 Claude 的默认，反之亦然', () => {
  const rig = build()
  // 先在 Claude 会话里选一个。
  const claude = rig.stateOf('s1')
  claude.mode = 'claude'
  claude.model = 'claude-sonnet-5'
  rig.rememberDefaults(claude)

  // 再去 Codex 会话里选一个。
  const codex = rig.stateOf('s2')
  codex.mode = 'codex'
  codex.model = 'kimi-k2.7-code'
  rig.rememberDefaults(codex)

  // 两个槽位各存各的。
  assert.equal(rig.defaults.model, 'claude-sonnet-5', '选 Codex 的模型不该改掉 Claude 那份')
  assert.equal(rig.defaults.codexModel, 'kimi-k2.7-code')

  // 新会话按引擎取各自的默认值 —— 这是这条修复的核心。
  const freshClaude = rig.stateOf('s3')
  freshClaude.mode = 'claude'
  assert.equal(rig.defaultModelFor('claude'), 'claude-sonnet-5')
  assert.equal(rig.defaultModelFor('codex'), 'kimi-k2.7-code')
})

test('开局那一份默认值跟着引擎走，不会把 claude-* 发给 Codex', () => {
  const rig = build()
  const claude = rig.stateOf('s1')
  claude.mode = 'claude'
  claude.model = 'claude-opus-5'
  rig.rememberDefaults(claude)
  // 让 Codex 成为当前引擎，模拟「上次选的是 Codex」。
  const codex = rig.stateOf('s2')
  codex.mode = 'codex'
  codex.model = ''
  rig.rememberDefaults(codex)

  // 新会话走 Codex：拿到的是 Codex 那份（空串＝跟随 codex 自己的配置），
  // 而不是 Claude 槽里的 claude-opus-5（那会必然 401）。
  const fresh = rig.stateOf('s3')
  assert.equal(fresh.mode, 'codex')
  assert.equal(fresh.model, '', 'Codex 会话不能继承 claude-* 的默认模型')
})

test('Codex 没记过模型时开局是空串，不是 Claude 的默认模型', () => {
  const rig = build()
  const codex = rig.stateOf('s1')
  codex.mode = 'codex'
  rig.rememberDefaults(codex)
  // 全新进程：codexModel 的出厂值是空串。
  const fresh = build()
  fresh.defaults.mode = 'codex'
  const state = fresh.stateOf('s1')
  assert.equal(state.model, '', '空串＝跟随 codex 自己的 config.toml')
})
