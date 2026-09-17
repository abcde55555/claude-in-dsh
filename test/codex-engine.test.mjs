// Codex 是本插件的第三个引擎：它没有常驻进程、没有 broker，每一轮就是一次
// `codex exec`（首轮）或 `codex exec resume <thread>`（之后每一轮）。
//
// 这里盯着两处最容易悄悄坏掉的东西：
//   1. codexArgv 里那几条实测出来的 CLI 事实（resume 不认 -s/-C、沙箱只能走
//      -c 覆盖、`--ephemeral` 不能用、提示词放在 `--` 之后）。
//   2. codexUsageOf 的减法：Codex 的 input_tokens 含缓存命中，而 dsh 的三个
//      字段是不相交的，不减就会让上下文计量表翻倍。
//
// 函数从 src/host.dynamic.js 里原样切出来跑，不是对着源码做正则。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 大括号配平地切出一个函数声明（和 session-defaults.test.mjs 同一套）。 */
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

/** 沙箱清单也从源码里取，免得测试和实现各写一份。 */
function sandboxCatalog() {
  const start = source.indexOf('    const CODEX_SANDBOXES = [')
  const end = source.indexOf('    /** Codex 新会话的默认沙箱档')
  assert.ok(start > 0 && end > start, 'CODEX_SANDBOXES 的位置变了')
  const body = source.slice(start, end)
  const fallback = source.match(/const DEFAULT_CODEX_SANDBOX = '([^']+)'/)
  assert.notEqual(fallback, null, 'DEFAULT_CODEX_SANDBOX 不见了')
  const list = new Function(body + '; return CODEX_SANDBOXES')()
  return { sandboxes: list, fallback: fallback[1] }
}

function build() {
  const { sandboxes, fallback } = sandboxCatalog()
  const deps = { CODEX_SANDBOXES: sandboxes, DEFAULT_CODEX_SANDBOX: fallback }
  const names = ['codexArgv', 'codexUsageOf', 'uuid']
  const made = new Function('deps', `'use strict';

    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, sandboxes: sandboxes, fallback: fallback }
}

/** createCodexTranscript 只用得到 session.append、uuid 和两个常量。 */
function transcriptRig() {
  const deps = { PROVIDER_CODEX: 'codex', NOTICE_MODEL: 'cc-mode/notice', uuid: build().uuid }
  const made = new Function('deps', `'use strict';

    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('createCodexTranscript')}
    return { createCodexTranscript }
  `)(deps)
  const events = []
  const session = { append: (type, data, opts) => events.push({ type: type, data: data, opts: opts }) }
  return { transcript: made.createCodexTranscript(session, 7, 'deepseek-v4.1-flash'), events: events }
}

/** argv 里 `-c` 后面跟的那串值，按 key 取。 */
function configValue(argv, key) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== '-c') continue
    const text = String(argv[index + 1])
    if (text.startsWith(key + '=')) return text.slice(key.length + 1)
  }
  return undefined
}

test('默认沙箱档是清单里的一个具体档', () => {
  const rig = build()
  assert.ok(rig.sandboxes.some((entry) => entry.id === rig.fallback),
    '出厂默认必须能在座位里选回来，否则一点开菜单就落在一个显示不出来的值上')
})

test('首轮：exec --json，没有 resume，工作目录交给 spawn 的 cwd', () => {
  const rig = build()
  const argv = rig.codexArgv({ codexSandbox: 'workspace-write', model: 'deepseek-v4.1-flash', effort: '' }, null, '你好')
  assert.equal(argv[0], 'exec')
  assert.ok(!argv.includes('resume'), '没有 thread 就不该续接')
  assert.ok(argv.includes('--json'))
  assert.ok(argv.includes('--skip-git-repo-check'), 'dsh 的会话目录不一定是 git 仓库')
  // resume 那条路不认 -C，所以两边统一不传，靠 spawn 的 cwd（resume 也按 cwd 过滤）。
  assert.ok(!argv.includes('-C') && !argv.includes('--cd'))
  assert.equal(argv[argv.length - 1], '你好')
  assert.equal(argv[argv.length - 2], '--', '用户的第一句话可能以 - 开头，必须落在 -- 之后')
  assert.equal(configValue(argv, 'sandbox_mode'), '"workspace-write"')
})

test('续接：resume <thread> 放在 exec 之后、选项之前', () => {
  const rig = build()
  const argv = rig.codexArgv({ codexSandbox: 'read-only', model: 'x', effort: '' }, '01a0ad21-6d98-72c3', '再来')
  assert.equal(argv[0], 'exec')
  assert.equal(argv[1], 'resume')
  assert.equal(argv[2], '01a0ad21-6d98-72c3')
  assert.ok(!argv.includes('-s') && !argv.includes('--sandbox'),
    'resume 不认 -s，沙箱只能走 -c（实测：unexpected argument \'-s\' found）')
  assert.ok(!argv.includes('--ephemeral'), '用了 --ephemeral 就不落盘，resume 也就没了')
  assert.equal(configValue(argv, 'sandbox_mode'), '"read-only"')
})

test('图片走 -i，每张一个 -i，且落在 -- 之前', () => {
  const rig = build()
  const argv = rig.codexArgv(
    { codexSandbox: 'workspace-write', model: 'x', effort: '' }, null, '这是什么颜色',
    ['/tmp/a.png', '/tmp/b.jpg'])
  const dashes = argv.indexOf('--')
  const iAt = argv.map((v, i) => (v === '-i' ? i : -1)).filter((i) => i !== -1)
  assert.equal(iAt.length, 2, '两张图就是两个 -i')
  assert.deepEqual(iAt.map((i) => argv[i + 1]), ['/tmp/a.png', '/tmp/b.jpg'])
  assert.ok(iAt.every((i) => i < dashes), '-i 是选项，必须在 -- 之前')
  // exec 和 resume 都认 -i（实测），所以续接那一轮同样带得动图
  const resumed = rig.codexArgv(
    { codexSandbox: 'workspace-write', model: 'x', effort: '' }, '01a0ad21-6d98-72c3', '再看这张', ['/tmp/c.png'])
  assert.equal(resumed[1], 'resume')
  assert.ok(resumed.includes('-i') && resumed.includes('/tmp/c.png'))
  assert.ok(resumed.indexOf('-i') < resumed.indexOf('--'))
})

test('没有图片时不出现 -i（别给 Codex 塞空参数）', () => {
  const rig = build()
  for (const value of [undefined, [], ['', null]]) {
    const argv = rig.codexArgv({ codexSandbox: 'workspace-write', model: 'x', effort: '' }, null, '嗨', value)
    assert.ok(!argv.includes('-i'), '没有可用路径就不该有 -i：' + JSON.stringify(value))
  }
})

test('没选模型就不传 -m，让 Codex 用它自己 config.toml 里的 model', () => {
  const rig = build()
  const argv = rig.codexArgv({ codexSandbox: 'workspace-write', model: '', effort: '' }, null, '嗨')
  assert.ok(!argv.includes('-m'))
})

test('思考档空着不传；选了就原样透传给 model_reasoning_effort', () => {
  const rig = build()
  const off = rig.codexArgv({ codexSandbox: 'workspace-write', model: 'm', effort: '' }, null, '嗨')
  assert.equal(configValue(off, 'model_reasoning_effort'), undefined)
  const on = rig.codexArgv({ codexSandbox: 'workspace-write', model: 'm', effort: 'xhigh' }, null, '嗨')
  assert.equal(configValue(on, 'model_reasoning_effort'), '"xhigh"')
})

test('认不出的沙箱档回落到出厂值，而不是把一个瞎猜的值递给 CLI', () => {
  const rig = build()
  const argv = rig.codexArgv({ codexSandbox: 'yolo', model: 'm', effort: '' }, null, '嗨')
  assert.equal(configValue(argv, 'sandbox_mode'), '"' + rig.fallback + '"')
})

test('usage：input_tokens 含缓存命中，必须把 cached 减出去', () => {
  const rig = build()
  // 实测一轮：input_tokens 151817，其中 151168 命中缓存。dsh 的字段不相交，
  // 计量表又把它们相加，所以这里要还原成 649 + 151168 = 151817。
  const usage = rig.codexUsageOf({
    input_tokens: 151817,
    cached_input_tokens: 151168,
    cache_write_input_tokens: 0,
    output_tokens: 185,
    reasoning_output_tokens: 181,
  })
  assert.equal(usage.inputTokens, 649)
  assert.equal(usage.cacheReadTokens, 151168)
  assert.equal(usage.outputTokens, 185)
  assert.equal(usage.reasoningTokens, 181)
  assert.ok(!('cacheWriteTokens' in usage), '这一轮没有缓存写入，就不该凭空造一个 0 出来')
  const pressure = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
  assert.equal(pressure, 151817, '上下文压力就是 prompt 总量，不翻倍也不缩水')
})

// 这条是踩出来的：`stream: []` 一度被写在 message 里面而不是事件这一层。
// 写入时看不出任何异常，UI 当场也渲染得好好的 —— 直到重新打开这个会话：
// 投影拿 data.stream 去 .some()/.length，undefined 直接把历史读崩
// （"Cannot read properties of undefined (reading 'length')"）。而会话日志只追加，
// 写错一次这个会话就永久打不开了。所以它值得一条测试守着。
test('assistant/message 的 stream 在事件这一层，不在 message 里', () => {
  const rig = transcriptRig()
  rig.transcript.note('⚠ 这一轮失败了')
  const messages = rig.events.filter((event) => event.type === 'assistant/message')
  assert.equal(messages.length, 1)
  assert.ok(Array.isArray(messages[0].data.stream), 'stream 必须是事件层的数组')
  assert.equal(messages[0].data.stream.length, 0)
  assert.ok(!('stream' in messages[0].data.message), '写进 message 里等于没写')
  // 每一条都必须如此，不只有说明那一条。
  const rig2 = transcriptRig()
  rig2.transcript.text('普通回复')
  rig2.transcript.finish()
  for (const event of rig2.events.filter((e) => e.type === 'assistant/message')) {
    assert.ok(Array.isArray(event.data.stream), '每条 assistant/message 都要带事件层的 stream')
  }
})

test('一轮结束时还挂着的工具调用会被补上结果，并带上 turn/step', () => {
  const rig = transcriptRig()
  rig.transcript.announceCall('call-1', 'bash', { command: 'ls' })
  rig.transcript.finish()
  const call = rig.events.find((event) => event.type === 'tool/call')
  const result = rig.events.find((event) => event.type === 'tool/result')
  assert.equal(call.data.callId, 'call-1')
  assert.equal(call.data.name, 'bash')
  assert.equal(result.data.message.source.callId, 'call-1')
  assert.equal(result.data.message.content[0].isError, true, '没等到结果的调用要标成错误，否则 dsh 的历史里它永远悬着')
  assert.equal(result.data.turn, 7)
  // 同一个 call 不再补第二次。
  const before = rig.events.length
  rig.transcript.settleCall('call-1', '迟到的结果', false)
  assert.equal(rig.events.length, before, '已经答过的调用不该再写一条结果')
})

test('usage：全是缓存命中时不会算成负数；缺字段不炸', () => {
  const rig = build()
  const cached = rig.codexUsageOf({ input_tokens: 100, cached_input_tokens: 100, output_tokens: 1 })
  assert.equal(cached.inputTokens, 0)
  assert.equal(rig.codexUsageOf(null), undefined)
  assert.equal(rig.codexUsageOf(undefined), undefined)
  const bare = rig.codexUsageOf({ input_tokens: 10, output_tokens: 2 })
  assert.ok(!('cacheReadTokens' in bare), '没有缓存字段就别写缓存字段')
})
