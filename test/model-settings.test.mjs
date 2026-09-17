// 模型目录的设置面板：一份人和插件共写的 JSON，现在能增、能改、能删、能隐藏、
// 能按引擎设默认值。这里跑的是真函数——读文件的规范化、编辑的规则、写回的形状
// ——而不是对着源码做正则。
//
// 写文件那一步（cat > 临时文件 && mv）在测试里被换成「记下来 + 让下一次读返回
// 它」，所以整条链路（读 → 改 → 写 → 回读）是真的跑通了，只是不碰磁盘。

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

/** 内置清单本身，从源码里取（测试不该另抄一份）。 */
function builtinModels() {
  const decl = host.indexOf('    const MODELS = [')
  assert.ok(decl > 0, '内置清单搬走了')
  const open = host.indexOf('[', decl)
  let depth = 0
  for (let i = open; i < host.length; i += 1) {
    if (host[i] === '[') depth += 1
    else if (host[i] === ']') {
      depth -= 1
      if (depth === 0) return new Function('return ' + host.slice(open, i + 1))()
    }
  }
  throw new Error('MODELS 没有配对的 ]')
}

const HOME_WORD = '"$HOME"/.cache/ccmode'

/**
 * 一个装了真函数的沙盒。`file` 是「磁盘上」那份 models.json 的文本（空串＝
 * 文件不存在），写回会替换它，所以回读拿到的是刚写的东西——和真实链路一样。
 */
function build(file) {
  const MODELS = builtinModels()
  const state = { text: file }
  const calls = { persisted: 0, written: [], paths: [] }
  const deps = {
    MODELS: MODELS,
    DEFAULT_MODEL: 'claude-opus-5',
    MODELS_PATH: HOME_WORD + '/models.json',
    STATE_DIR: HOME_WORD,
    // 两个调用方共用这一个 stub（读文件、展开 $HOME），按命令区分。
    runCapture: (argv) => Promise.resolve(
      String(argv[2] || '').indexOf('printf %s "$HOME"') !== -1 ? '/Users/test' : state.text),
    writeJsonFile: (target, value) => {
      calls.written.push(value)
      calls.paths.push(target)
      state.text = JSON.stringify(value, null, 2) + '\n'
      return Promise.resolve()
    },
    defaults: { model: 'claude-opus-5', codexModel: '' },
    persistStates: () => { calls.persisted += 1 },
  }
  const names = ['isBuiltinModel', 'modelFitsEngine', 'readModelsFile', 'refreshKnownModels',
    'isKnownModel', 'expandHome', 'modelDisplayName', 'applyModelsEdit', 'modelsState', 'modelsEdit']
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    let knownModelIds = new Set(MODELS.map((m) => m.id))
    let cachedDefaultModel = 'claude-opus-5'
    let cachedDefaultCodexModel = ''
    let cachedHome = null
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, MODELS: MODELS, deps: deps, state: state, calls: calls }
}

const CUSTOM = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', reasoning: false },
]

test('老的纯数组写法仍然读得懂', () => {
  // 手写过这个文件的人不该因为加了面板就读不出来了。
  const rig = build(JSON.stringify(CUSTOM))
  return rig.readModelsFile().then((answer) => {
    assert.equal(answer.custom.length, 2)
    assert.equal(answer.all.length, rig.MODELS.length + 2)
    assert.equal(answer.defaultModel, 'claude-opus-5', '数组写法不带默认值，落在出厂值上')
    assert.equal(answer.defaultCodexModel, '')
    assert.deepEqual(answer.hidden, [])
  })
})

test('同 id 以内置为准，自定义里的同 id 被丢掉', () => {
  const rig = build(JSON.stringify([{ id: 'claude-opus-5', name: '假的 Opus', reasoning: false }]))
  return rig.readModelsFile().then((answer) => {
    assert.equal(answer.custom.length, 0)
    assert.equal(answer.all.find((m) => m.id === 'claude-opus-5').name, 'Claude Opus 5')
  })
})

test('隐藏的模型不出现在可选清单里，但仍然是「认识的」', () => {
  // 隐藏只是不列出来。已经跑在这个模型上的会话不该因为一次隐藏就恢复不了——
  // isKnownModel 是状态恢复那条路的校验。
  const rig = build(JSON.stringify({ hidden: ['claude-opus-4-5'], models: [] }))
  return rig.refreshKnownModels().then((answer) => {
    assert.equal(answer.models.some((m) => m.id === 'claude-opus-4-5'), false)
    assert.equal(answer.all.some((m) => m.id === 'claude-opus-4-5'), true)
    assert.equal(rig.isKnownModel('claude-opus-4-5'), true)
  })
})

test('幽灵隐藏项（清单里已经没有的 id）不会浮出来', () => {
  const rig = build(JSON.stringify({ hidden: ['claude-opus-4-5', '早就删掉的模型'], models: [] }))
  return rig.readModelsFile().then((answer) => {
    assert.deepEqual(answer.hidden, ['claude-opus-4-5'])
  })
})

test('Codex 的默认模型是另一个槽位，且 claude-* 落回空串', () => {
  const rig = build(JSON.stringify({ defaultModel: 'kimi-k2.7-code', defaultCodexModel: 'claude-opus-5', models: CUSTOM }))
  return rig.readModelsFile().then((answer) => {
    assert.equal(answer.defaultModel, 'kimi-k2.7-code')
    // 写了个 Codex 用不了的就当没写：空串＝跟随 codex 自己的 config.toml，
    // 那是个能开局的组合，claude-* 是必然 401。
    assert.equal(answer.defaultCodexModel, '')
  })
})

test('增：自定义模型能加，名字留空就用 id', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'add', id: 'glm-5', name: '', reasoning: true }).then((answer) => {
    assert.equal(rig.calls.written.length, 1)
    assert.deepEqual(rig.calls.written[0].models, [{ id: 'glm-5', name: 'glm-5', reasoning: true }])
    assert.equal(answer.models.some((m) => m.id === 'glm-5' && m.builtin === false), true)
  })
})

test('增：id 不合法、重复、撞内置都拒掉，且什么都不写', () => {
  const rig = build(JSON.stringify(CUSTOM))
  const cases = [
    { id: '', why: '空 id' },
    { id: '   ', why: '只有空白的 id' },
    { id: 'claude-opus-5', why: '撞内置（内置只能隐藏，不能覆盖）' },
    { id: 'kimi-k2.7-code', why: '已经存在的自定义' },
    { id: 'bad id', why: '带空格' },
    { id: '-leading-dash', why: '以符号开头' },
  ]
  return cases.reduce((chain, entry) => chain.then(() => rig
    .modelsEdit({ op: 'add', id: entry.id, name: 'x', reasoning: true })
    .then(() => assert.fail('该拒绝：' + entry.why), (error) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.length > 0)
    })), Promise.resolve()).then(() => {
    assert.equal(rig.calls.written.length, 0, '一次都不该写文件')
  })
})

test('增：reasoning 必须是布尔值', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'add', id: 'glm-5', name: 'GLM', reasoning: 'yes' })
    .then(() => assert.fail('该拒绝'), (error) => {
      assert.match(error.message, /布尔/)
      assert.equal(rig.calls.written.length, 0)
    })
})

test('改：改名与 reasoning，id 不动', () => {
  const rig = build(JSON.stringify(CUSTOM))
  return rig.modelsEdit({ op: 'update', id: 'kimi-k2.7-code', name: 'Kimi K2.7', reasoning: true })
    .then((answer) => {
      const written = rig.calls.written[0].models.find((m) => m.id === 'kimi-k2.7-code')
      assert.deepEqual(written, { id: 'kimi-k2.7-code', name: 'Kimi K2.7', reasoning: true })
      assert.equal(answer.models.find((m) => m.id === 'kimi-k2.7-code').reasoning, true)
    })
})

test('改：内置模型改不动，只能说隐藏', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'update', id: 'claude-opus-5', name: '我的 Opus', reasoning: true })
    .then(() => assert.fail('该拒绝'), (error) => {
      assert.match(error.message, /内置模型不能改/)
      assert.equal(rig.calls.written.length, 0)
    })
})

test('删：内置删不掉，自定义删得掉', () => {
  const rig = build(JSON.stringify(CUSTOM))
  return rig.modelsEdit({ op: 'remove', id: 'claude-opus-5' })
    .then(() => assert.fail('内置不该删得掉'), (error) => {
      assert.match(error.message, /内置模型不能删除/)
      return rig.modelsEdit({ op: 'remove', id: 'kimi-k2.7-code' })
    }).then((answer) => {
      assert.equal(answer.models.some((m) => m.id === 'kimi-k2.7-code'), false)
      assert.equal(answer.models.some((m) => m.id === 'deepseek-v4.1-flash'), true)
    })
})

test('删：顺手抹掉它的隐藏标记', () => {
  // 留着的话，用户下次加回同一个 id，加进来就是隐藏状态，而他不会想到去看那个字段。
  const rig = build(JSON.stringify({ hidden: ['kimi-k2.7-code'], models: CUSTOM }))
  return rig.modelsEdit({ op: 'remove', id: 'kimi-k2.7-code' }).then(() => {
    assert.deepEqual(rig.calls.written[0].hidden, [])
  })
})

test('删：删掉的正好是默认模型时，默认值落回安全值', () => {
  // 不落的话新会话会开在一个清单里已经没有的模型上——Claude 那边 CLI 报错，
  // Codex 那边是 401。
  const claudeRig = build(JSON.stringify({ defaultModel: 'kimi-k2.7-code', models: CUSTOM }))
  return claudeRig.modelsEdit({ op: 'remove', id: 'kimi-k2.7-code' })
    .then((answer) => assert.equal(answer.defaults.claude, 'claude-opus-5'))
    .then(() => {
      const codexRig = build(JSON.stringify({ defaultCodexModel: 'kimi-k2.7-code', models: CUSTOM }))
      return codexRig.modelsEdit({ op: 'remove', id: 'kimi-k2.7-code' })
        .then((answer) => assert.equal(answer.defaults.codex, '', 'Codex 槽落回空串＝跟随它自己的配置'))
    })
})

test('隐藏 / 恢复：写的是 hidden 字段，一处生效于所有引擎', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'hide', id: 'claude-opus-4-5', hidden: true })
    .then((answer) => {
      assert.deepEqual(rig.calls.written[0].hidden, ['claude-opus-4-5'])
      assert.equal(answer.models.find((m) => m.id === 'claude-opus-4-5').hidden, true)
      return rig.modelsEdit({ op: 'hide', id: 'claude-opus-4-5', hidden: false })
    }).then((answer) => {
      assert.deepEqual(rig.calls.written[1].hidden, [])
      assert.equal(answer.models.find((m) => m.id === 'claude-opus-4-5').hidden, false)
    })
})

test('隐藏：不存在的模型拒掉', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'hide', id: '没有这个', hidden: true })
    .then(() => assert.fail('该拒绝'), (error) => {
      assert.match(error.message, /没有这个模型/)
      assert.equal(rig.calls.written.length, 0)
    })
})

test('设默认：Claude/dsh 不接受空串，Codex 接受（＝跟随它自己的配置）', () => {
  const rig = build(JSON.stringify({ models: CUSTOM }))
  return rig.modelsEdit({ op: 'default', engine: 'claude', model: '' })
    .then(() => assert.fail('Claude 槽不该能设空'), (error) => {
      assert.match(error.message, /不能是空的/)
      return rig.modelsEdit({ op: 'default', engine: 'codex', model: '' })
    }).then((answer) => {
      assert.equal(answer.defaults.codex, '')
      assert.equal(rig.calls.written[0].defaultCodexModel, '')
      assert.equal(rig.calls.written[0].defaultModel, 'claude-opus-5', 'Claude 槽没被动过')
    })
})

test('设默认：Codex 拒绝 claude-*，Claude 照单全收', () => {
  const rig = build(JSON.stringify({ models: CUSTOM }))
  return rig.modelsEdit({ op: 'default', engine: 'codex', model: 'claude-opus-5' })
    .then(() => assert.fail('Codex 不该收 claude-*'), (error) => {
      assert.match(error.message, /Codex 用不了/)
      return rig.modelsEdit({ op: 'default', engine: 'claude', model: 'claude-opus-5' })
    }).then((answer) => {
      assert.equal(answer.defaults.claude, 'claude-opus-5')
      assert.equal(answer.defaults.codex, '', 'Codex 槽原样留着')
      assert.equal(rig.calls.written.length, 1, '只有成功的那次写了文件')
    })
})

test('设默认：清单里没有的模型拒掉', () => {
  const rig = build('')
  return rig.modelsEdit({ op: 'default', engine: 'claude', model: 'gpt-9' })
    .then(() => assert.fail('该拒绝'), (error) => assert.match(error.message, /没有这个模型/))
})

test('设默认：两个引擎的槽位各写各的（这是刚修好的行为，别退化）', () => {
  // state.json 那份「用户上次显式选过的东西」优先级比 models.json 高，所以设
  // 默认值必须两个落点一起写，否则下次重启会被旧的显式选择盖回去。
  const rig = build(JSON.stringify({ models: CUSTOM }))
  return rig.modelsEdit({ op: 'default', engine: 'codex', model: 'kimi-k2.7-code' })
    .then(() => {
      assert.equal(rig.deps.defaults.codexModel, 'kimi-k2.7-code')
      assert.equal(rig.deps.defaults.model, 'claude-opus-5', 'Claude 槽不该被顺手改掉')
      assert.equal(rig.calls.persisted, 1)
      return rig.modelsEdit({ op: 'default', engine: 'claude', model: 'deepseek-v4.1-flash' })
    }).then(() => {
      assert.equal(rig.deps.defaults.model, 'deepseek-v4.1-flash')
      assert.equal(rig.deps.defaults.codexModel, 'kimi-k2.7-code', 'Codex 槽原样留着')
    })
})

test('写回的是对象形态，两个默认值和 hidden 都在', () => {
  // 纯数组那份文件被面板改过一次之后会变成对象——数组形态放不下这两个字段。
  const rig = build(JSON.stringify(CUSTOM))
  return rig.modelsEdit({ op: 'add', id: 'glm-5', name: 'GLM 5', reasoning: true }).then(() => {
    const written = rig.calls.written[0]
    assert.deepEqual(Object.keys(written), ['defaultModel', 'defaultCodexModel', 'hidden', 'models'])
    assert.equal(written.defaultModel, 'claude-opus-5')
    assert.equal(written.defaultCodexModel, '')
    assert.equal(written.models.length, 3)
    assert.deepEqual(rig.calls.paths[0], HOME_WORD + '/models.json')
  })
})

test('models.get 的返回值带内置/隐藏标记，且列的是含隐藏项的全量', () => {
  // 设置面板要能看见被隐藏的行（否则没法恢复），模型座要的是不含它们的清单
  // ——后者走 catalog，两者是同一份读法的两个投影。
  const rig = build(JSON.stringify({ hidden: ['claude-haiku-4-5'], models: CUSTOM }))
  return rig.modelsState().then((state) => {
    assert.equal(state.path, '/Users/test/.cache/ccmode/models.json')
    assert.equal(state.models.length, rig.MODELS.length + 2)
    const hidden = state.models.find((m) => m.id === 'claude-haiku-4-5')
    assert.equal(hidden.hidden, true)
    assert.equal(hidden.builtin, true)
    assert.equal(state.models.find((m) => m.id === 'kimi-k2.7-code').builtin, false)
    assert.equal(state.defaults.claude, 'claude-opus-5')
  })
})

test('改动之后 knownModelIds 立刻跟上（不必重启）', () => {
  // 「改完模型清单立刻生效」这条链路里，host 侧的同步缓存是最容易漏的一环：
  // 它是 model.set / 状态恢复校验用的那份。
  const rig = build('')
  return rig.modelsEdit({ op: 'add', id: 'glm-5', name: 'GLM 5', reasoning: false }).then(() => {
    assert.equal(rig.isKnownModel('glm-5'), true)
    return rig.modelsEdit({ op: 'remove', id: 'glm-5' })
  }).then(() => assert.equal(rig.isKnownModel('glm-5'), false))
})

test('未知操作 / 未知引擎都拒掉，不会写出一份空清单', () => {
  const rig = build(JSON.stringify(CUSTOM))
  return rig.modelsEdit({ op: 'nope' })
    .then(() => assert.fail('该拒绝'), (error) => assert.match(error.message, /未知操作/))
    .then(() => rig.modelsEdit({ op: 'default', engine: 'gpt', model: 'x' }))
    .then(() => assert.fail('该拒绝'), (error) => assert.match(error.message, /未知引擎/))
    .then(() => assert.equal(rig.calls.written.length, 0))
})

test('读文件失败（不是 JSON）时静默退回内置清单', () => {
  const rig = build('{ 这不是 JSON')
  return rig.readModelsFile().then((answer) => {
    assert.equal(answer.all.length, rig.MODELS.length)
    assert.equal(answer.defaultModel, 'claude-opus-5')
  })
})
