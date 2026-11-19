/**
 * Real-model bench for the prompt enhancer.
 *
 * Sends every draft from bench/examples.json through the SAME system prompt the
 * plugin uses (`buildMetaPrompt`) against an OpenAI-compatible streaming
 * endpoint, then reports latency, output text and automated style checks so a
 * prompt change can be judged on evidence instead of vibes.
 *
 * Default endpoint is the local channel gateway (the route the plugin itself
 * resolves through the DSH profile). Nothing here is sent anywhere else.
 *
 *   node tools/bench-enhancer.mjs                        # all examples
 *   node tools/bench-enhancer.mjs --only ui-plugin-zh    # one example
 *   node tools/bench-enhancer.mjs --model loomy/GLM-5.3-Flash --effort none
 *   node tools/bench-enhancer.mjs --base-url http://127.0.0.1:8326/v1 --api-key <k>
 *
 * Exit code is 0 unless the endpoint failed; style failures are reported, not
 * thrown, because "is this a good prompt" needs a human/LLM judgment above the
 * hard checks.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { buildMetaPrompt, cleanModelOutput } from '../src/rewrite.mjs'

const args = process.argv.slice(2)
function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

function defaultGatewayKey() {
  try {
    return readFileSync(path.join(homedir(), '.dsh', 'openai-gateway', 'api-key'), 'utf8').trim()
  } catch {
    return ''
  }
}

const baseUrl = String(flag('base-url', 'http://127.0.0.1:8326/v1')).replace(/\/+$/, '')
const apiKey = flag('api-key', process.env.DSH_OPENAI_GATEWAY_API_KEY ?? defaultGatewayKey())
const model = String(flag('model', 'loomy/deepseek-v4-flash-1017'))
const effort = flag('effort', 'none')
const maxTokens = Number(flag('max-tokens', 768))
const only = flag('only', null)
const outDir = flag('out', path.resolve(process.cwd(), 'bench', 'results'))
const timeoutMs = Number(flag('timeout', 180000))

if (!apiKey) {
  console.error('no API key: pass --api-key, set DSH_OPENAI_GATEWAY_API_KEY, or create ~/.dsh/openai-gateway/api-key')
  process.exit(2)
}

const corpus = JSON.parse(await readFile(path.resolve(process.cwd(), 'bench', 'examples.json'), 'utf8'))
const examples = corpus.examples.filter((item) => !only || item.id === only)
if (examples.length === 0) {
  console.error(`no example matched --only ${only}`)
  process.exit(2)
}

function styleIssues(draft, output, expect = [], forbid = []) {
  const issues = []
  if (!output) return ['empty output']
  if (/^\s*(目标|背景|约束|产出|验收|要求|Goal|Context|Constraints|Deliverable)\s*[:：]/m.test(output)) {
    issues.push('labeled section line (目标：/Goal: style)')
  }
  if (/(^|\n)\s*#{1,6}\s/.test(output)) issues.push('markdown heading')
  if (/\*\*[^*\n]+\*\*/.test(output)) issues.push('bold markdown')
  if (/(^|\n)\s*[-*]\s+/.test(output)) issues.push('bullet list')
  if (/```/.test(output)) issues.push('code fence')
  if (/（默认[:：]|\(default[:：]/i.test(output)) issues.push('invented default disclaimer')
  // The v0.3.5 failure mode: the model answered with a step-by-step process
  // brief instead of a descriptive request. These markers are the tell.
  if (/请先|然后|接着|请找出|请运行|请给出|请说明|再进行|依次执行/.test(output)) {
    issues.push('process-brief style (请先…然后…)')
  }
  // Absolute length budget: the reference shape is a short descriptive
  // request, not a multi-clause acceptance plan. Short drafts expand, but
  // the ceiling is what matters — the ratio check alone flagged 6-char
  // drafts as "too long" for a perfectly reasonable 200-char result.
  if (output.length > 260) issues.push(`too long (${output.length} chars)`)
  if (output.length < 30) issues.push(`too short (${output.length} chars)`)
  const cjk = (output.match(/[\u4e00-\u9fff]/g) ?? []).length
  const letters = (output.match(/[A-Za-z]/g) ?? []).length
  const draftCjk = (draft.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (draftCjk >= 2 && cjk < output.length * 0.35) issues.push('language drifted away from Chinese')
  if (draftCjk < 2 && letters < output.length * 0.3) issues.push('language drifted away from English')
  for (const word of forbid) {
    if (word && output.includes(word)) issues.push(`forbidden pattern: ${word}`)
  }
  const missing = expect.filter((word) => word && !output.toLowerCase().includes(word.toLowerCase()))
  if (missing.length) issues.push(`missing expected content: ${missing.join(', ')}`)
  return issues
}

async function streamOnce(draft) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let firstTextAt = null
  let text = ''
  let reasoningChars = 0
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: maxTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [
          { role: 'system', content: buildMetaPrompt({ locale: 'auto' }) },
          { role: 'user', content: draft },
        ],
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 400)}`)
    }
    if (!response.body) throw new Error('response had no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk
        try { chunk = JSON.parse(data) } catch { continue }
        const delta = chunk?.choices?.[0]?.delta ?? {}
        if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length
        else if (typeof delta.reasoning === 'string') reasoningChars += delta.reasoning.length
        const piece = typeof delta.content === 'string' ? delta.content : ''
        if (piece) {
          if (firstTextAt === null) firstTextAt = Date.now() - started
          text += piece
        }
      }
    }
    return {
      text: cleanModelOutput(text),
      rawText: text,
      totalMs: Date.now() - started,
      firstTextMs: firstTextAt,
      reasoningChars,
    }
  } finally {
    clearTimeout(timer)
  }
}

const results = []
for (const example of examples) {
  process.stdout.write(`→ ${example.id} (${example.draft.length} chars) ... `)
  try {
    const run = await streamOnce(example.draft)
    const issues = styleIssues(example.draft, run.text, example.expect, example.forbid)
    const result = { ...example, ...run, issues }
    results.push(result)
    console.log(`${run.totalMs}ms, ttft ${run.firstTextMs ?? '-'}ms, ${run.text.length} chars${issues.length ? ' ISSUES: ' + issues.join('; ') : ' ok'}`)
  } catch (error) {
    results.push({ ...example, error: String(error?.message ?? error), issues: ['request failed'] })
    console.log(`FAILED: ${error?.message ?? error}`)
  }
}

await mkdir(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const jsonPath = path.join(outDir, `bench-${stamp}.json`)
const mdPath = path.join(outDir, `bench-${stamp}.md`)
const meta = { model, effort, maxTokens, baseUrl, at: new Date().toISOString() }
await writeFile(jsonPath, JSON.stringify({ meta, results }, null, 2), 'utf8')

const lines = [
  `# Prompt-enhancer bench — ${model} (effort ${effort ?? 'default'})`,
  '',
  `- ${meta.at}`,
  `- max_tokens ${maxTokens}, endpoint ${baseUrl}`,
  '',
]
for (const item of results) {
  lines.push(`## ${item.id}`, '', `**Draft:** ${item.draft}`, '')
  if (item.error) {
    lines.push(`**ERROR:** ${item.error}`, '')
    continue
  }
  lines.push(
    `**Enhanced (${item.text.length} chars, ${item.totalMs}ms, ttft ${item.firstTextMs ?? '-'}ms):**`,
    '',
    item.text,
    '',
    item.issues.length ? `**Style issues:** ${item.issues.join('; ')}` : '**Style issues:** none (automated checks)',
    '',
  )
}
await writeFile(mdPath, lines.join('\n'), 'utf8')
console.log(`\nreport: ${mdPath}`)
