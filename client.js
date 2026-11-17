/**
 * dsh-prompt-enhancer — browser half.
 *
 * A lightweight right-sidebar tab for reviewing local text evidence and adding
 * optional user-supplied context, without model calls or automatic rewriting.
 * The browser bundle is intentionally hand-authored: it only depends on the
 * React instance provided by DSH's ModuleLoader and keeps all state in-panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'promptEnhancer'
    const KIND = 'prompt-enhancer'
    const ID = 'dsh-prompt-enhancer'
    const ENDPOINT = '/api/prompt-enhancer/enhance'

    const DICT = {
      zh: {
        'type.label': '想法增强',
        'guide.title': '想法增强',
        'guide.description': '本地识别原文线索，按需补充说明，不调用模型',
        title: '想法增强',
        subtitle: '本地线索整理；不调用模型，也不会用模型重写。不判断原文是否缺失或完整。',
        original: '原始想法',
        placeholder: '例如：帮我做一个产品发布计划……',
        profile: '增强风格',
        profileGeneral: '通用',
        profileWriting: '写作',
        profileProduct: '产品方案',
        profileCoding: '编程',
        enhance: '分析想法',
        enhancing: '分析中…',
        clear: '清空',
        enhanced: '增强稿',
        enhancedPlaceholder: '原文默认保留，可在这里直接编辑',
        preserved: '原文已保留',
        facts: '原文中已表达',
        reviewNotes: '识别说明',
        questions: '可选澄清',
        answer: '你的回答（可选）',
        answerPlaceholder: '只填写你愿意加入草稿的真实补充，留空不会加入',
        addAnswers: '将回答加入草稿',
        answersApplied: '回答已加入本次草稿；如需修改，请直接编辑草稿。不会重复追加。',
        supplement: '补充说明',
        assumptions: '假设（如有）',
        changes: '变更摘要',
        risks: '风险标记',
        noItems: '暂无',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败，请手动选择并复制增强稿。',
        accept: '确认增强稿',
        accepted: '已确认，请复制后自行粘贴',
        undo: '撤销增强',
        restore: '恢复原文',
        errorPrefix: '增强失败：{message}',
        required: '请先输入原始想法',
        retry: '重试',
        hint: '确认增强稿仅在本面板标记确认；请复制后自行粘贴到输入框，不会自动回填或发送消息。',
      },
      en: {
        'type.label': 'Idea enhancer',
        'guide.title': 'Idea enhancer',
        'guide.description': 'Review local text clues and optionally add context; no model calls',
        title: 'Idea enhancer',
        subtitle: 'Local text-clue review; no model calls or model rewriting. It does not judge whether an idea is missing information or complete.',
        original: 'Original idea',
        placeholder: 'For example: create a product launch plan…',
        profile: 'Profile',
        profileGeneral: 'General',
        profileWriting: 'Writing',
        profileProduct: 'Product plan',
        profileCoding: 'Coding',
        enhance: 'Review idea',
        enhancing: 'Reviewing…',
        clear: 'Clear',
        enhanced: 'Enhanced draft',
        enhancedPlaceholder: 'The original is preserved by default; edit the draft directly',
        preserved: 'Original preserved',
        facts: 'Already expressed in the original',
        reviewNotes: 'Review notes',
        questions: 'Optional clarifications',
        answer: 'Your answer (optional)',
        answerPlaceholder: 'Only enter real context you want in the draft; blanks are not added',
        addAnswers: 'Add answers to draft',
        answersApplied: 'Answers added to this draft. Edit the draft directly to make changes; answers will not be appended again.',
        supplement: 'Additional context',
        assumptions: 'Assumptions (if any)',
        changes: 'Change summary',
        risks: 'Risk flags',
        noItems: 'None',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed. Select and copy the draft manually.',
        accept: 'Confirm draft',
        accepted: 'Confirmed; copy and paste it yourself',
        undo: 'Undo enhancement',
        restore: 'Restore original',
        errorPrefix: 'Enhancement failed: {message}',
        required: 'Enter an original idea first',
        retry: 'Retry',
        hint: 'Confirm draft only marks it confirmed in this panel. Copy it and paste it into the input yourself; nothing is backfilled or sent automatically.',
      },
    }

    const CSS = `
.pe{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#111);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.pe-head{padding:12px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));flex:none}
.pe-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.pe-subtitle{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}
.pe-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 16px}
.pe-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#666)}
.pe-textarea{width:100%;box-sizing:border-box;min-height:92px;resize:vertical;padding:8px 9px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));background:var(--dsw-alias-bg-primary,#fff);color:inherit;font:inherit;font-size:13px;line-height:1.5}
.pe-textarea:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c8dff) 35%,transparent);border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.pe-select{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));background:var(--dsw-alias-bg-primary,#fff);color:inherit;font:inherit}
.pe-field{margin-bottom:11px}
.pe-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pe-btn{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.pe-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.pe-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.pe-btn[disabled]{opacity:.5;cursor:default}
.pe-btn-primary{border-color:var(--dsw-alias-state-business-primary,#4c8dff);background:var(--dsw-alias-state-business-primary,#4c8dff);color:var(--dsw-alias-static-white,#fff)}
.pe-btn-primary:hover{filter:brightness(1.05)}
.pe-status{margin:8px 0;padding:7px 9px;border-radius:var(--dsw-radius-sm,8px);font-size:11px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.04))}
.pe-error{color:var(--dsw-alias-state-danger-primary,#c33);background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#c33) 9%,transparent)}
.pe-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin:8px 0 0}
.pe-result{margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.pe-result-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:10px 0 6px}
.pe-result-title{font-weight:600;font-size:13px}
.pe-result-actions{display:flex;gap:5px}
.pe-result-actions .pe-btn{min-height:24px;padding:0 7px;font-size:11px}
.pe-card{margin-top:9px;padding:8px 9px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.025))}
.pe-card-title{margin:0 0 5px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em}
.pe-card-body{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-primary,#111)}
.pe-fact{margin:7px 0}
.pe-evidence{margin:3px 0 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));white-space:pre-wrap;word-break:break-word;font-size:12px}
.pe-question{margin-top:10px}
.pe-question .pe-label{display:block;color:inherit}
.pe-question .pe-textarea{min-height:60px}
.pe-list{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-primary,#111)}
.pe-list li{margin:3px 0;word-break:break-word}
.pe-chip-list{display:flex;flex-wrap:wrap;gap:5px}
.pe-chip{padding:2px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));font-size:11px;word-break:break-word}
.pe-chip-warn{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warning-primary,#a06000)}
.pe-accepted{color:var(--dsw-alias-state-success-primary,#2b8a3e)}
`

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => values && values[key] !== undefined ? String(values[key]) : `{${key}}`)
    }

    function normaliseList(value) {
      if (value == null) return []
      const itemText = (item) => {
        if (typeof item === 'string') return item.trim() ? item : ''
        if (item == null) return ''
        if (typeof item !== 'object') return String(item)
        const description = typeof item.description === 'string' ? item.description.trim() : ''
        const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
        if (description || reason) return description && reason && description !== reason ? `${description} — ${reason}` : description || reason
        // Unknown objects are omitted rather than exposing raw JSON to the user.
        for (const key of ['text', 'label', 'question']) {
          if (typeof item[key] === 'string' && item[key].trim()) return item[key]
        }
        return ''
      }
      return (Array.isArray(value) ? value : [value]).map(itemText).filter(Boolean)
    }

    async function callJson(path, init) {
      const response = await window.fetch(path, {
        method: init?.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        credentials: 'same-origin',
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      })
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok || !payload || payload.ok === false) {
        const message = payload && (payload.error || payload.message) ? (payload.error || payload.message) : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    function extractResult(payload, original) {
      const source = payload?.result ?? payload?.data ?? payload
      const enhanced = source?.enhancedPrompt ?? source?.enhanced ?? source?.draft ?? source?.prompt ?? source?.text
      const questions = normaliseList(source?.missingQuestions ?? source?.clarifyingQuestions ?? source?.clarificationQuestions ?? source?.questions)
      const seen = new Set()
      // An explicit empty clarifications array means no questions, even if an
      // older compatibility field is also present. Legacy APIs get stable IDs.
      const clarifications = (Array.isArray(source?.clarifications) ? source.clarifications : questions.map((question, index) => ({ id: `legacy-${index + 1}`, question })))
        .filter((item) => item && typeof item.question === 'string' && item.question.trim())
        .slice(0, 2)
        .map((item, index) => {
          const candidate = typeof item.id === 'string' && item.id.trim() ? item.id : `clarification-${index + 1}`
          let id = candidate
          while (seen.has(id)) id += `-${index + 1}`
          seen.add(id)
          return { id, question: item.question, reason: typeof item.reason === 'string' ? item.reason : '', evidence: typeof item.evidence === 'string' ? item.evidence : '' }
        })
      // Only quote facts that can be verified verbatim in this exact original.
      // Never turn a host label, confidence score or inferred summary into evidence.
      const recognizedFacts = (Array.isArray(source?.recognizedFacts) ? source.recognizedFacts : []).flatMap((item) => {
        if (!item || typeof item.label !== 'string' || !item.label.trim() || typeof item.evidence !== 'string' || !item.evidence.trim()) return []
        const located = original.indexOf(item.evidence)
        if (located < 0) return []
        const validSpan = Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= original.length && original.slice(item.start, item.end) === item.evidence
        const start = validSpan ? item.start : located
        return [{ key: typeof item.key === 'string' ? item.key : '', label: item.label, evidence: item.evidence, start, end: validSpan ? item.end : start + item.evidence.length }]
      })
      return {
        enhanced: typeof enhanced === 'string' && enhanced.trim() ? enhanced : original,
        questions,
        clarifications,
        recognizedFacts,
        reviewNotes: normaliseList(source?.reviewNotes),
        assumptions: normaliseList(source?.assumptions),
        changes: normaliseList(source?.changeSet ?? source?.changeSummary ?? source?.changes ?? source?.summary),
        risks: normaliseList(source?.riskFlags ?? source?.risks ?? source?.risk),
      }
    }

    function ListCard({ title, items, warning }) {
      if (!items.length) return null
      return h('section', { className: 'pe-card' },
        h('h3', { className: 'pe-card-title' }, title),
        warning
          ? h('div', { className: 'pe-chip-list' }, items.map((item, index) => h('span', { className: 'pe-chip pe-chip-warn', key: `${index}-${item}` }, item)))
          : h('ul', { className: 'pe-list' }, items.map((item, index) => h('li', { key: `${index}-${item}` }, item))))
    }

    function FactsCard({ facts, title }) {
      if (!facts.length) return null
      return h('section', { className: 'pe-card' },
        h('h3', { className: 'pe-card-title' }, title),
        facts.map((fact, index) => h('div', { className: 'pe-fact', key: `${fact.key}-${index}` },
          h('strong', { className: 'pe-card-body' }, fact.label),
          h('blockquote', { className: 'pe-evidence' }, fact.evidence))))
    }

    function EnhancerBody(props) {
      const { t } = props
      const [original, setOriginal] = useState('')
      const [result, setResult] = useState(null)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [lastOriginal, setLastOriginal] = useState('')
      const [accepted, setAccepted] = useState(false)
      const [answers, setAnswers] = useState({})
      const [answersApplied, setAnswersApplied] = useState(false)
      // A ref closes the gap before React rerenders disabled controls. Every
      // operation checks it too, so even callbacks retained by an old render
      // cannot clear/edit/confirm a request that is still running.
      const request = useRef({ busy: false, revision: 0 })
      // This is also checked by retained callbacks before React can rerender.
      const applied = useRef(false)
      const resetAnswers = useCallback(() => {
        applied.current = false
        setAnswers({})
        setAnswersApplied(false)
      }, [])
      useEffect(() => () => {
        request.current.busy = false
        request.current.revision += 1
      }, [])

      const enhance = useCallback(async () => {
        if (request.current.busy) return
        resetAnswers()
        if (!original.trim()) {
          setError(t('required'))
          setResult(null)
          return
        }
        const revision = ++request.current.revision
        request.current.busy = true
        setBusy(true)
        setError(null)
        setNotice(null)
        setAccepted(false)
        setLastOriginal(original)
        // Never leave a previous draft actionable while a new result is pending.
        setResult(null)
        setDraft('')
        try {
          const payload = await callJson(ENDPOINT, { method: 'POST', body: { text: original, idea: original, profile: 'general' } })
          if (request.current.revision !== revision) return
          const next = extractResult(payload, original)
          setResult(next)
          setDraft(next.enhanced)
        } catch (cause) {
          if (request.current.revision !== revision) return
          // Keep the exact original available when the service is unavailable.
          setResult(null)
          setDraft(original)
          setError(cause?.message ?? String(cause))
        } finally {
          if (request.current.revision === revision) {
            request.current.busy = false
            setBusy(false)
          }
        }
      }, [original, resetAnswers, t])

      const clear = useCallback(() => {
        if (request.current.busy) return
        request.current.revision += 1
        setOriginal('')
        setLastOriginal('')
        setResult(null)
        setDraft('')
        setError(null)
        setNotice(null)
        setAccepted(false)
        resetAnswers()
      }, [resetAnswers])

      const undo = useCallback(() => {
        if (request.current.busy || !result) return
        request.current.revision += 1
        setOriginal(lastOriginal)
        setDraft(lastOriginal)
        setResult(null)
        setAccepted(false)
        resetAnswers()
        setNotice(t('restore'))
      }, [lastOriginal, result, resetAnswers, t])

      const copy = useCallback(async () => {
        if (request.current.busy) return
        const revision = request.current.revision
        const text = result ? draft : original
        if (!text) return
        let copied = false
        try {
          await navigator.clipboard.writeText(text)
          copied = true
        } catch {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.focus(); area.select()
          try { copied = document.execCommand('copy') === true } catch { copied = false } finally { area.remove() }
        }
        if (request.current.revision === revision && !request.current.busy) setNotice(t(copied ? 'copied' : 'copyFailed'))
      }, [draft, original, result, t])

      const accept = useCallback(() => {
        if (request.current.busy || !result || !draft.trim()) return
        setAccepted(true)
        setNotice(t('accepted'))
      }, [draft, result, t])

      const answerRevision = request.current.revision
      const addAnswers = useCallback(() => {
        if (request.current.busy || applied.current || !result || request.current.revision !== answerRevision) return
        const answered = result.clarifications.flatMap((item) => {
          const answer = typeof answers[item.id] === 'string' ? answers[item.id] : ''
          if (!answer.trim()) return []
          return [`- ${item.question}\n  ${answer.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ')}`]
        })
        if (!answered.length) return
        applied.current = true
        // Append only actual answers to the CURRENT draft. Never regenerate it
        // from the result/original or copy an unanswered question or example.
        setDraft((current) => `${current}${current ? '\n\n' : ''}${t('supplement')}\n${answered.join('\n')}`)
        setAnswersApplied(true)
        setAccepted(false)
        setNotice(null)
        request.current.revision += 1
      }, [answers, result, answerRevision, t])

      const hasAnswers = result?.clarifications.some((item) => typeof answers[item.id] === 'string' && answers[item.id].trim())

      return h('div', { className: 'pe' },
        h('div', { className: 'pe-head' },
          h('h2', { className: 'pe-title' }, t('title')),
          h('p', { className: 'pe-subtitle' }, t('subtitle'))),
        h('div', { className: 'pe-body' },
          h('div', { className: 'pe-field' },
            h('label', { className: 'pe-label', htmlFor: `${ID}-original` }, t('original')),
            h('textarea', {
              id: `${ID}-original`,
              className: 'pe-textarea',
              value: original,
              placeholder: t('placeholder'),
              onChange: (event) => {
                if (request.current.busy) return
                request.current.revision += 1
                setOriginal(event.target.value)
                setResult(null)
                setDraft(event.target.value)
                setAccepted(false)
                setError(null)
                setNotice(null)
                resetAnswers()
              },
              disabled: busy,
            })),
          h('div', { className: 'pe-actions' },
            h('button', { className: 'pe-btn pe-btn-primary', disabled: busy, onClick: enhance }, busy ? t('enhancing') : t('enhance')),
            h('button', { className: 'pe-btn', disabled: busy, onClick: clear }, t('clear'))),
          error ? h('div', { className: 'pe-status pe-error' }, format(t('errorPrefix'), { message: error }), h('button', { className: 'pe-btn', style: { marginLeft: 6 }, onClick: enhance, disabled: busy }, t('retry'))) : null,
          notice ? h('div', { className: `pe-status${accepted ? ' pe-accepted' : ''}` }, notice) : null,
          result
            ? h('div', { className: 'pe-result' },
              h(FactsCard, { title: t('facts'), facts: result.recognizedFacts }),
              h(ListCard, { title: t('reviewNotes'), items: result.reviewNotes }),
              h('div', { className: 'pe-result-head' },
                h('label', { className: 'pe-result-title', htmlFor: `${ID}-draft` }, draft === lastOriginal ? t('preserved') : t('enhanced')),
                h('div', { className: 'pe-result-actions' },
                  h('button', { className: 'pe-btn', onClick: copy, disabled: busy }, t('copy')),
                  h('button', { className: 'pe-btn', onClick: undo, disabled: busy }, t('undo')))),
              h('textarea', {
                id: `${ID}-draft`, className: 'pe-textarea', value: draft, placeholder: t('enhancedPlaceholder'), disabled: busy,
                onChange: (event) => { if (!request.current.busy) { setDraft(event.target.value); setAccepted(false); setNotice(null) } },
              }),
              h('div', { className: 'pe-actions' },
                h('button', { className: 'pe-btn pe-btn-primary', onClick: accept, disabled: busy }, accepted ? t('accepted') : t('accept'))),
              result.clarifications.length ? h('section', { className: 'pe-card' },
                h('h3', { className: 'pe-card-title' }, t('questions')),
                result.clarifications.map((item) => {
                  const answerId = `${ID}-answer-${encodeURIComponent(item.id)}`
                  return h('div', { className: 'pe-question', key: item.id },
                    h('label', { className: 'pe-label', htmlFor: answerId }, item.question),
                    item.reason ? h('p', { className: 'pe-hint' }, item.reason) : null,
                    h('textarea', {
                      id: answerId, 'aria-label': `${item.question} — ${t('answer')}`,
                      className: 'pe-textarea', value: typeof answers[item.id] === 'string' ? answers[item.id] : '', placeholder: t('answerPlaceholder'), disabled: busy || answersApplied,
                      onChange: (event) => {
                        if (request.current.busy || applied.current || request.current.revision !== answerRevision) return
                        const value = event.target.value
                        setAnswers((current) => ({ ...current, [item.id]: value }))
                      },
                    }))
                }),
                h('div', { className: 'pe-actions' },
                  h('button', { className: 'pe-btn', disabled: busy || answersApplied || !hasAnswers, onClick: addAnswers }, t('addAnswers'))),
                answersApplied ? h('p', { className: 'pe-hint', role: 'status' }, t('answersApplied')) : null) : null,
              h(ListCard, { title: t('assumptions'), items: result.assumptions, t }),
              h(ListCard, { title: t('changes'), items: result.changes, t }),
              h(ListCard, { title: t('risks'), items: result.risks, warning: true, t }))
            : null,
          h('p', { className: 'pe-hint' }, t('hint'))))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'prompt-enhancer: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'prompt-enhancer: styles')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [{ id: 'prompt-enhancer', order: 35, title: () => t('guide.title'), description: () => t('guide.description') }],
      }), 'prompt-enhancer: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, EnhancerBody)), 'prompt-enhancer: tab body')
    }

    exports.name = 'prompt-enhancer-client'
    exports.inject = ['slots', 'locale', 'sidebarRightTabs']
    exports.apply = apply
    exports.__test = { ID, KIND, DICT, extractResult, normaliseList, EnhancerBody }
    return module.exports
  },
})
