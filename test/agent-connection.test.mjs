// 引擎的连接配置：每个 agent 的 baseUrl / key，以及它们怎么进到 claude / codex 的启动参数里。
//
// 这条链路最容易出的错都是「静默无效」：值写进去了但没传下去、传下去了但引擎不认、
// 或者清空之后旧密钥还留在磁盘上。所以这里测的都是**能观测的后果** —— 写出的 argv、
// 写出的文件、调用的 rm —— 而不是「函数被调过」。
//
// 密钥不进 argv 是本文件里最要紧的一条断言：claude 进程是 broker 以
// `node broker.mjs <dir> <argv…>` 拉起来的，argv 会出现在 `ps` 里。

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
  // async 前缀要一起带上，否则函数体里的 await 会落进非 async 函数、直接语法错。
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

/** 从源码里取字面量，免得测试另抄一份会过期。 */
function literal(pattern, label) {
  const hit = host.match(pattern)
  assert.notEqual(hit, null, `找不到 ${label}`)
  return hit[0]
}

function build(overrides) {
  const options = overrides || {}
  const calls = { rm: [], wrote: [], logged: [], errored: [] }
  const deps = {
    ENGINE_IDS: ['dsh', 'claude', 'codex'],
    DEFAULT_AGENT_NAMES: { dsh: 'DSH', claude: 'Claude Code', codex: 'Codex' },
    isEngineId: (value) => ['dsh', 'claude', 'codex'].indexOf(value) !== -1,
    AGENTS_PATH: '"$HOME"/.cache/ccmode/agents.json',
    STATE_DIR: '"$HOME"/.cache/ccmode',
    console: {
      log: (...a) => calls.logged.push(a.join(' ')),
      error: (...a) => calls.errored.push(a.join(' ')),
    },
    expandHome: (word) => Promise.resolve(String(word).split('"$HOME"').join('/Users/test')),
    shellQuote: (value) => "'" + String(value) + "'",
    runCapture: (argv) => {
      if (options.configToml !== undefined) return Promise.resolve(options.configToml)
      calls.rm.push(argv[2])
      return Promise.resolve('')
    },
    writeSecretJsonFile: (target, value) => {
      calls.wrote.push({ target, value })
      return Promise.resolve()
    },
  }
  const names = [
    'emptyConnection', 'readConnection', 'validateConnection', 'defaultAgents',
    'applyAgentsEdit', 'activeCodexProvider', 'codexConnectionArgs', 'writeClaudeSettingsFile',
  ]
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${literal(/const AGENT_CONNECTION_FIELDS = \{[\s\S]*?\n    \}/, 'AGENT_CONNECTION_FIELDS')}
    ${literal(/const AGENT_SOURCES = \[[\s\S]*?\]/, 'AGENT_SOURCES')}
    ${literal(/const CODEX_KEY_ENV = '[^']+'/, 'CODEX_KEY_ENV')}
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, calls: calls }
}

// ---------- 哪些引擎有连接字段 ----------

test('出厂值：claude 与 codex 有连接字段，dsh 没有', () => {
  const rig = build()
  const agents = rig.defaultAgents()
  // dsh 的连接由 dsh 自己那套设置管，插件去写只会和它打架 —— 所以它压根没有这些字段。
  assert.equal(agents.dsh.connection, undefined)
  assert.deepEqual(Object.keys(agents.claude.connection), ['baseUrl', 'apiKey', 'authToken'])
  assert.deepEqual(Object.keys(agents.codex.connection), ['baseUrl', 'apiKey', 'provider'])
})

test('出厂全是空串 —— 空串的意思是「不覆盖，用这个引擎自己的配置」', () => {
  const rig = build()
  const agents = rig.defaultAgents()
  for (const field of Object.values(agents.claude.connection)) assert.equal(field, '')
  for (const field of Object.values(agents.codex.connection)) assert.equal(field, '')
})

test('给 dsh 配连接要被拒掉，且说清为什么', () => {
  const rig = build()
  assert.throws(() => rig.validateConnection('dsh', { baseUrl: 'http://x' }),
    /没有可配的连接字段/, 'dsh 的连接不该由插件管，报错要说得出这一点')
})

// ---------- 读进来的坏值 ----------

test('注册表里的坏值逐个丢掉，不让整份注册表失效', () => {
  const rig = build()
  // agents.json 是外部输入：一份写坏的连接配置最坏只该让那个引擎退回「用自己配置」，
  // 不该让整个注册表读不出来。
  const connection = rig.readConnection('claude', { baseUrl: ' http://x ', apiKey: 123, authToken: null, 乱入: 'y' })
  assert.equal(connection.baseUrl, 'http://x', '两头的空白要去掉')
  assert.equal(connection.apiKey, '', '数字不是字符串，丢掉而不是转成 "123"')
  assert.equal(connection.authToken, '', 'null 丢掉')
  assert.ok(!('乱入' in connection), '不认识的字段不该进来')
})

test('dsh 读出来是 undefined，客户端据此不渲染连接输入框', () => {
  const rig = build()
  assert.equal(rig.readConnection('dsh', { baseUrl: 'x' }), undefined)
})

// ---------- 写进来的值 ----------

test('非字符串、超长要拒掉；空串合法', () => {
  const rig = build()
  assert.throws(() => rig.validateConnection('claude', { apiKey: 42 }), /必须是字符串/)
  assert.throws(() => rig.validateConnection('claude', { apiKey: 'x'.repeat(501) }), /太长/)
  assert.equal(rig.validateConnection('claude', { apiKey: '' }).apiKey, '', '空串＝不覆盖，合法')
})

test('不传 connection 时，原有连接与其它字段都保持原样', () => {
  const rig = build()
  // 最要紧的向后兼容：老的调用方（只传 id/name/source）不能被弄坏。
  const before = {
    dsh: { name: 'DSH', source: 'local' },
    claude: { name: 'CC', source: 'local', connection: { baseUrl: 'http://keep', apiKey: 'sk-keep', authToken: '' } },
    codex: { name: 'CX', source: 'local', connection: { baseUrl: '', apiKey: '', provider: '' } },
  }
  const after = rig.applyAgentsEdit(before, { id: 'claude', name: 'CC2', source: 'remote' })
  assert.equal(after.claude.name, 'CC2')
  assert.equal(after.claude.source, 'remote')
  assert.equal(after.claude.connection.baseUrl, 'http://keep', '没传 connection 就该保持原样')
  assert.equal(after.claude.connection.apiKey, 'sk-keep')
})

test('传了 connection 就整个替换（不是逐字段合并）', () => {
  const rig = build()
  const before = {
    dsh: { name: 'DSH', source: 'local' },
    claude: { name: 'CC', source: 'local', connection: { baseUrl: 'http://old', apiKey: 'sk-old', authToken: 'tk-old' } },
    codex: { name: 'CX', source: 'local', connection: { baseUrl: '', apiKey: '', provider: '' } },
  }
  const after = rig.applyAgentsEdit(before, {
    id: 'claude', name: 'CC', source: 'local',
    connection: { baseUrl: 'http://new', apiKey: '', authToken: '' },
  })
  assert.equal(after.claude.connection.baseUrl, 'http://new')
  assert.equal(after.claude.connection.apiKey, '', '替换语义：没给的就清掉，不是留旧的')
  assert.equal(after.claude.connection.authToken, '')
})

// ---------- claude：连接怎么进启动参数 ----------

test('claude 没有覆盖时：不写文件、返回 null（argv 里就不加 --settings）', () => {
  const rig = build()
  return rig.writeClaudeSettingsFile({ baseUrl: '', apiKey: '', authToken: '' }).then((result) => {
    assert.equal(result, null)
    assert.equal(rig.calls.wrote.length, 0)
  })
})

test('claude 清空覆盖时要删掉旧文件 —— 否则明文密钥留在磁盘上', async () => {
  const rig = build()
  // 「清空 key」之后那份旧 settings 还在，功能上不会被读（argv 里不加 --settings），
  // 但把明文密钥留在那儿本身就是问题。
  const result = await rig.writeClaudeSettingsFile({ baseUrl: '', apiKey: '', authToken: '' })
  assert.equal(result, null)
  assert.equal(rig.calls.rm.length, 1, '应当调一次 rm')
  assert.match(rig.calls.rm[0], /rm -f .*agent-settings\/claude\.json/)
})

test('claude 的覆盖文件只写给了值的那几项', async () => {
  const rig = build()
  const target = await rig.writeClaudeSettingsFile({ baseUrl: 'http://gw', apiKey: 'sk-a', authToken: '' })
  assert.match(target, /agent-settings\/claude\.json$/)
  assert.equal(rig.calls.wrote.length, 1)
  assert.deepEqual(rig.calls.wrote[0].value, { env: { ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_API_KEY: 'sk-a' } })
  assert.equal('ANTHROPIC_AUTH_TOKEN' in rig.calls.wrote[0].value.env, false, '空的那项不写，免得覆盖成空')
})

// ---------- codex：连接怎么进启动参数 ----------

test('codex 什么都不配时不加任何参数', async () => {
  const rig = build()
  const result = await rig.codexConnectionArgs({ baseUrl: '', apiKey: '' })
  assert.deepEqual(result.argv, [])
  assert.equal(result.env, undefined)
})

test('codex 的 provider 默认取 config.toml 里 model_provider 指的那个', async () => {
  const rig = build({ configToml: '[model_providers.opencode]\n' + 'model_provider = "opencode"\n' })
  const result = await rig.codexConnectionArgs({ baseUrl: 'http://gw/v1', apiKey: '' })
  assert.equal(result.argv[1], 'model_providers.opencode.base_url="http://gw/v1"',
    '覆盖的是**当前那个** provider，不新建 —— 新建会丢掉它原有的 wire_api / http_headers')
})

test('codex 的密钥不进 argv：argv 里只有环境变量的名字', async () => {
  const rig = build()
  const result = await rig.codexConnectionArgs({ baseUrl: '', apiKey: 'sk-secret', provider: 'mine' })
  assert.equal(result.argv.join(' ').indexOf('sk-secret'), -1, '密钥不能出现在 argv（ps 看得到）')
  assert.ok(result.argv.join(' ').indexOf('env_key=') !== -1, 'argv 里给的是变量名')
  assert.equal(result.env.CCMODE_CODEX_CREDENTIAL, 'sk-secret', '真值走显式 env')
})

test('codex 的密钥变量名不含 KEY/TOKEN，躲开 dsh 的敏感名过滤', () => {
  const name = host.match(/const CODEX_KEY_ENV = '([^']+)'/)[1]
  // dsh 的 scrubbedParentEnv 按 /KEY|PASSWORD|SECRET|TOKEN/i 剥**继承**来的环境变量。
  // 显式传的 env 在它之后展开、本来不会被剥，但用中性名字等于多一层保险。
  assert.doesNotMatch(name, /KEY|PASSWORD|SECRET|TOKEN/i)
})

test('codex 明确指定了 provider 就用它，不去读 config.toml', async () => {
  const rig = build({ configToml: 'model_provider = "fromfile"' })
  const result = await rig.codexConnectionArgs({ baseUrl: 'http://x', apiKey: '', provider: 'explicit' })
  assert.equal(result.argv[1], 'model_providers.explicit.base_url="http://x"')
})

test('codex 找不到可覆盖的 provider 时跳过，而不是瞎猜一个', async () => {
  const rig = build({ configToml: '# 没有 model_provider\n' })
  const result = await rig.codexConnectionArgs({ baseUrl: 'http://x', apiKey: '' })
  assert.deepEqual(result.argv, [], '猜一个 provider 名字只会静默改错东西')
  assert.equal(rig.calls.errored.length, 1, '要留下痕迹，别静默什么都不做')
})

// ---------- 密钥不该进日志 ----------

test('任何日志里都不出现密钥', async () => {
  const rig = build()
  await rig.codexConnectionArgs({ baseUrl: 'http://x', apiKey: 'sk-must-not-be-logged', provider: 'mine' })
  await rig.writeClaudeSettingsFile({ baseUrl: 'http://x', apiKey: 'sk-must-not-be-logged', authToken: '' })
  const everything = rig.calls.logged.concat(rig.calls.errored).join('\n')
  assert.equal(everything.indexOf('sk-must-not-be-logged'), -1, '日志会进 dsh 的 stdout，密钥不能进去')
})
