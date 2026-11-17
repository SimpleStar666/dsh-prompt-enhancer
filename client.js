/**
 * dsh-prompt-enhancer — browser half.
 *
 * A lightweight right-sidebar tab that turns a rough idea into a clearer prompt.
 * The browser bundle is intentionally hand-authored: it only depends on the
 * React instance provided by DSH's ModuleLoader and keeps all state in-panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'promptEnhancer'
    const KIND = 'prompt-enhancer'
    const ID = 'dsh-prompt-enhancer'
    const ENDPOINT = '/api/prompt-enhancer/enhance'

    const DICT = {
      zh: {
        'type.label': '想法增强',
        'guide.title': '想法增强',
        'guide.description': '把原始想法整理成可直接使用的提示词',
        title: '想法增强',
        subtitle: '输入一个想法，让它变得更清晰、可执行',
        original: '原始想法',
        placeholder: '例如：帮我做一个产品发布计划……',
        profile: '增强风格',
        profileGeneral: '通用',
        profileWriting: '写作',
        profileProduct: '产品方案',
        profileCoding: '编程',
        enhance: '增强',
        enhancing: '增强中…',
        clear: '清空',
        enhanced: '增强稿',
        enhancedPlaceholder: '增强后的内容会显示在这里，可直接编辑',
        questions: '澄清问题',
        assumptions: '假设',
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
        'guide.description': 'Turn a rough idea into a usable prompt',
        title: 'Idea enhancer',
        subtitle: 'Give an idea some structure and make it actionable',
        original: 'Original idea',
        placeholder: 'For example: create a product launch plan…',
        profile: 'Profile',
        profileGeneral: 'General',
        profileWriting: 'Writing',
        profileProduct: 'Product plan',
        profileCoding: 'Coding',
        enhance: 'Enhance',
        enhancing: 'Enhancing…',
        clear: 'Clear',
        enhanced: 'Enhanced draft',
        enhancedPlaceholder: 'The enhanced prompt appears here and remains editable',
        questions: 'Clarifying questions',
        assumptions: 'Assumptions',
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
.pe-result-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.pe-result-title{font-weight:600;font-size:13px}
.pe-result-actions{display:flex;gap:5px}
.pe-result-actions .pe-btn{min-height:24px;padding:0 7px;font-size:11px}
.pe-card{margin-top:9px;padding:8px 9px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.025))}
.pe-card-title{margin:0 0 5px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em}
.pe-card-body{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-primary,#111)}
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
      return {
        enhanced: typeof enhanced === 'string' && enhanced.trim() ? enhanced : original,
        questions: normaliseList(source?.missingQuestions ?? source?.clarifyingQuestions ?? source?.clarificationQuestions ?? source?.questions),
        assumptions: normaliseList(source?.assumptions),
        changes: normaliseList(source?.changeSet ?? source?.changeSummary ?? source?.changes ?? source?.summary),
        risks: normaliseList(source?.riskFlags ?? source?.risks ?? source?.risk),
      }
    }

    function ListCard({ title, items, warning, t }) {
      return h('section', { className: 'pe-card' },
        h('h3', { className: 'pe-card-title' }, title),
        items.length
          ? warning
            ? h('div', { className: 'pe-chip-list' }, items.map((item, index) => h('span', { className: 'pe-chip pe-chip-warn', key: `${index}-${item}` }, item)))
            : h('ul', { className: 'pe-list' }, items.map((item, index) => h('li', { key: `${index}-${item}` }, item)))
          : h('div', { className: 'pe-card-body' }, t('noItems')))
    }

    function EnhancerBody(props) {
      const { t } = props
      const [original, setOriginal] = useState('')
      const [profile, setProfile] = useState('general')
      const [result, setResult] = useState(null)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [lastOriginal, setLastOriginal] = useState('')
      const [accepted, setAccepted] = useState(false)
      // A ref closes the gap before React rerenders disabled controls. Every
      // operation checks it too, so even callbacks retained by an old render
      // cannot clear/edit/confirm a request that is still running.
      const request = useRef({ busy: false, revision: 0 })
      useEffect(() => () => {
        request.current.busy = false
        request.current.revision += 1
      }, [])

      const profileOptions = useMemo(() => [
        ['general', t('profileGeneral')],
        ['writing', t('profileWriting')],
        ['product', t('profileProduct')],
        ['coding', t('profileCoding')],
      ], [t])

      const enhance = useCallback(async () => {
        if (request.current.busy) return
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
          const payload = await callJson(ENDPOINT, { method: 'POST', body: { text: original, idea: original, profile } })
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
      }, [original, profile, t])

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
      }, [])

      const undo = useCallback(() => {
        if (request.current.busy || !result) return
        request.current.revision += 1
        setOriginal(lastOriginal)
        setDraft(lastOriginal)
        setResult(null)
        setAccepted(false)
        setNotice(t('restore'))
      }, [lastOriginal, result, t])

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
              },
              disabled: busy,
            })),
          h('div', { className: 'pe-field' },
            h('label', { className: 'pe-label', htmlFor: `${ID}-profile` }, t('profile')),
            h('select', {
              id: `${ID}-profile`, className: 'pe-select', value: profile, disabled: busy,
              onChange: (event) => { if (!request.current.busy) setProfile(event.target.value) },
            }, profileOptions.map(([value, label]) => h('option', { value, key: value }, label)))),
          h('div', { className: 'pe-actions' },
            h('button', { className: 'pe-btn pe-btn-primary', disabled: busy, onClick: enhance }, busy ? t('enhancing') : t('enhance')),
            h('button', { className: 'pe-btn', disabled: busy, onClick: clear }, t('clear'))),
          error ? h('div', { className: 'pe-status pe-error' }, format(t('errorPrefix'), { message: error }), h('button', { className: 'pe-btn', style: { marginLeft: 6 }, onClick: enhance, disabled: busy }, t('retry'))) : null,
          notice ? h('div', { className: `pe-status${accepted ? ' pe-accepted' : ''}` }, notice) : null,
          result
            ? h('div', { className: 'pe-result' },
              h('div', { className: 'pe-result-head' },
                h('div', { className: 'pe-result-title' }, t('enhanced')),
                h('div', { className: 'pe-result-actions' },
                  h('button', { className: 'pe-btn', onClick: copy, disabled: busy }, t('copy')),
                  h('button', { className: 'pe-btn', onClick: undo, disabled: busy }, t('undo')))),
              h('textarea', {
                className: 'pe-textarea', value: draft, placeholder: t('enhancedPlaceholder'), disabled: busy,
                onChange: (event) => { if (!request.current.busy) { setDraft(event.target.value); setAccepted(false) } },
              }),
              h('div', { className: 'pe-actions' },
                h('button', { className: 'pe-btn pe-btn-primary', onClick: accept, disabled: busy }, accepted ? t('accepted') : t('accept'))),
              h(ListCard, { title: t('questions'), items: result.questions, t }),
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
