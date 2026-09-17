// The model seat names the model a conversation runs. It used to carry a
// "follow Claude's own setting" row, which on a new conversation read
// 「Claude 默认」 — true, but it left the seat unable to say which model that
// was. The list is now concrete models only, with one concrete default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const host = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** The catalog literals, read out of the engine body. */
function catalog() {
  // 只取 MODELS 数组本身：从 `[` 做括号配对找到配对的 `]`。
  // 早先的写法切到 `const EFFORTS = [` 再删掉中间的 DEFAULT_MODEL 行，
  // 于是「MODELS 与 EFFORTS 之间只有一行」成了隐式契约——往中间插任何
  // 引用 DEFAULT_MODEL 的代码都会让这里的 eval 抛 ReferenceError。
  const decl = host.indexOf('    const MODELS = [')
  assert.ok(decl > 0, 'the catalog moved')
  const open = host.indexOf('[', decl)
  let depth = 0
  let close = -1
  for (let i = open; i < host.length; i += 1) {
    const ch = host[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) { close = i; break }
    }
  }
  assert.ok(close > open, 'MODELS array is unterminated')
  const defaults = host.match(/const DEFAULT_MODEL = '([^']+)'/)
  assert.ok(defaults !== null, 'DEFAULT_MODEL is gone')
  const models = new Function('return ' + host.slice(open, close + 1))()
  return { models: models, defaultModel: defaults[1] }
}

test('模型清单里只有具体模型', () => {
  const { models } = catalog()
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.notEqual(model.id, '', '「跟随 Claude 自己的设置」这一行不该再出现')
    assert.match(model.id, /^claude-/)
    assert.equal(typeof model.name, 'string')
    assert.ok(model.name.length > 0)
  }
})

test('默认模型是清单里的一个具体模型', () => {
  const { models, defaultModel } = catalog()
  assert.notEqual(defaultModel, '')
  assert.ok(models.some((model) => model.id === defaultModel),
    defaultModel + ' 不在清单里')
})

test('什么都没选过时，开局落在那个默认模型上', () => {
  const { defaultModel } = catalog()
  // 新会话的初值来自 defaults，而 defaults 自己的出厂值是这一行。
  // 出厂值分两个槽位：Claude 槽是编译进来的默认模型，Codex 槽是空串
  // （＝跟随 codex 自己的 config.toml，而不是替它挑一个 —— 挑错了就是 401）。
  const factory = host.match(/const defaults = \{([\s\S]*?)\n    \}/)
  assert.notEqual(factory, null, '找不到 defaults 的出厂值')
  assert.match(factory[1], /model: DEFAULT_MODEL,/, 'Claude 槽该落在编译进来的默认模型上')
  assert.match(factory[1], /codexModel: '',/, 'Codex 槽该是空串')
  assert.ok(defaultModel.length > 0)
})

test('新会话开在上一次选定的那套配置上', () => {
  // 在一个会话里选了 Claude、权限档和模型，下一个新会话就该这么开——
  // 而不是每次都退回 DSH 再手动切一遍。
  // 模型那一项跟着**引擎**取（defaultModelFor），不是一个全局槽位：
  // 两个引擎的清单不相通，共用槽位会把 claude-* 送进 Codex。
  assert.match(host, /state = \{\s*mode: defaults\.mode,\s*permissionMode: defaults\.permissionMode,[\s\S]*?model: defaultModelFor\(defaults\.mode\),\s*effort: defaults\.effort,/)
  // 只有三个选择器写这份默认：记的是「有人选了什么」，不是「某个会话恰好继承了什么」。
  assert.equal((host.match(/^\s+rememberDefaults\(state\)$/gm) || []).length, 3,
    '引擎、权限档、模型三个选择器各一次；多出来的话就是某处把继承来的值当成了选择')
})

test('老会话存下来的空选择仍然保留', () => {
  // 那些会话的进程已经跑在 Claude 自己的配置上；菜单少了一行不该悄悄换模型。
  // 校验走 isKnownModel()（含 models.json 的自定义模型），而不是硬编码的 MODELS——
  // 否则自定义模型「能看见但选不上」。
  assert.match(host, /saved\.model === ''\s*\|\|\s*isKnownModel\(saved\.model\)/)
})

test('「没什么可存」的判定跟着默认值走', () => {
  // 否则默认值非空会让每一个见过的会话都被写进状态文件。
  assert.match(host, /state\.model === DEFAULT_MODEL/)
  assert.doesNotMatch(host, /state\.permissionMode === 'manual' && state\.model === '' &&/)
})
