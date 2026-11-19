/**
 * dsh-prompt-enhancer — browser half.
 *
 * One-click prompt enhancement in the composer: a sparkle button between the
 * text area and the send controls. Clicking sends the current draft to the host
 * route, the host rewrites it through the configured DSH model, and the result
 * is written back into the draft for review before sending. One click again
 * (undo) restores the exact original draft. Nothing is sent automatically.
 *
 * The browser bundle is intentionally hand-authored: it only depends on the
 * React instance provided by DSH's ModuleLoader and keeps all state in the
 * button itself.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = 'promptEnhancer'
    const ID = 'dsh-prompt-enhancer'
    const ENDPOINT = '/api/prompt-enhancer/enhance'

    const DICT = {
      zh: {
        'type.label': '提示词增强',
        'guide.title': '提示词增强',
        'guide.description': '一键把当前草稿改写为更清晰的提示词，结果回填输入框供审阅',
        'button.enhance': '增强提示词',
        'button.busy': '正在增强提示词…',
        'button.undo': '撤销增强，恢复原文',
        'button.error': '增强失败：{message}（可重试）',
        'button.errorFatal': '增强失败：{message}',
        'button.empty': '请先输入内容',
      },
      en: {
        'type.label': 'Prompt enhance',
        'guide.title': 'Prompt enhance',
        'guide.description': 'Rewrite the current draft into a clearer prompt and put it back into the composer for review',
        'button.enhance': 'Enhance prompt',
        'button.busy': 'Enhancing prompt…',
        'button.undo': 'Undo enhancement and restore the original',
        'button.error': 'Enhancement failed: {message} (click to retry)',
        'button.errorFatal': 'Enhancement failed: {message}',
        'button.empty': 'Type something first',
      },
    }

    const CSS = `
@keyframes dsh-pe-spin{to{transform:rotate(360deg)}}
.dsh-pe-btn{
  display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;
  border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;
  opacity:.75;transition:opacity 120ms ease,background-color 120ms ease;
}
.dsh-pe-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-pe-btn:disabled{opacity:.45;cursor:default}
.dsh-pe-btn[data-error="true"]{color:var(--dsw-alias-state-danger-primary,#c33)}
.dsh-pe-btn[data-undo="true"]{color:var(--dsw-alias-state-danger-primary,#c33)}
.dsh-pe-spin{display:inline-flex;width:13px;height:13px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-pe-spin 700ms linear infinite}
`

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => values && values[key] !== undefined ? String(values[key]) : `{${key}}`)
    }

    function readDraftFromDom() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return ''
      const el = document.querySelector('[data-composer-input]')
      return el === null ? '' : (el.innerText ?? '')
    }

    function SparkleIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props,
      },
      h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }),
      h('path', { d: 'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }))
    }

    /**
     * The composer-toolbar button. Returns null when the host does not provide
     * the input actions the button needs, so unsupported hosts show nothing.
     */
    function EnhanceButton(props) {
      const { sessionId, inputActions, useInput, t } = props
      const draftFromHook = typeof useInput === 'function' ? useInput((state) => (state && typeof state.draft === 'string' ? state.draft : '')) : undefined
      const [busy, setBusy] = useState(false)
      // The `error` state doubles as the tooltip; the message and the visual
      // marker use separate state so the button can show feedback immediately.
      const [error, setError] = useState(null)
      const [retryable, setRetryable] = useState(false)
      const [failed, setFailed] = useState(false)
      const [undo, setUndo] = useState(null)
      const request = useRef(0)
       const abort = useRef(null)

      const canOperate = typeof inputActions?.setDraft === 'function' && sessionId != null
      // Some host builds do not pass a draft hook; fall back to reading the
      // composer DOM on demand and never hard-disable the button for emptiness.
      const draft = typeof draftFromHook === 'string' ? draftFromHook : readDraftFromDom()

      // Undo stays valid only while the enhanced text is untouched in the composer.
      useEffect(() => {
        if (undo === null) return undefined
        if (typeof draftFromHook === 'string' && draftFromHook.trim() !== undo.enhanced) setUndo(null)
        return undefined
      }, [draftFromHook, undo])

      // Error tooltip clears itself after a few seconds.
      useEffect(() => {
        if (!error) return undefined
        const timer = setTimeout(() => setError(null), 5000)
        return () => clearTimeout(timer)
      }, [error])

      useEffect(() => () => {
         request.current += 1
         abort.current?.abort()
         abort.current = null
       }, [])

      const onClick = useCallback(async () => {
        if (busy) return
        const label = typeof t === 'function' ? t : (key) => key
        if (undo !== null && draftFromHook !== undefined && draftFromHook.trim() === undo.enhanced) {
          inputActions.setDraft(undo.original)
          setUndo(null)
          return
        }
        const raw = (typeof draftFromHook === 'string' ? draftFromHook : readDraftFromDom()).trim()
        if (!raw) {
          setError(label('button.empty'))
          setRetryable(false)
          setFailed(true)
          return
        }
        const revision = ++request.current
         const controller = typeof AbortController === 'function' ? new AbortController() : null
         abort.current = controller
        setBusy(true)
        setError(null)
        setFailed(false)
        try {
          const response = await window.fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
             ...(controller ? { signal: controller.signal } : {}),
            body: JSON.stringify({ text: raw, sessionId }),
          })
          let payload = null
          try { payload = await response.json() } catch { payload = null }
          if (!response.ok || !payload || payload.ok === false) {
            const message = payload?.error || payload?.message || `HTTP ${response.status}`
            // `retryable` gates the tooltip suffix: a fatal provider failure
            // (quota exhausted, auth, unknown model) must not tell the user to
            // click again — that only spends another queue slot.
            const error = new Error(message)
            error.retryable = Boolean(payload?.retryable)
            throw error
          }
          if (request.current !== revision) return
          const enhanced = typeof payload.enhancedPrompt === 'string' ? payload.enhancedPrompt.trim() : ''
          if (enhanced && enhanced !== raw) {
            setUndo({ original: raw, enhanced })
            inputActions.setDraft(enhanced)
          }
        } catch (cause) {
          if (request.current !== revision) return
          setError(cause?.message ?? String(cause))
          setRetryable(Boolean(cause?.retryable))
          setFailed(true)
        } finally {
          if (abort.current === controller) abort.current = null
           if (request.current === revision) setBusy(false)
        }
      }, [busy, draftFromHook, undo, inputActions, sessionId, t])

      if (!canOperate) return null

      const showUndo = undo !== null && draft === undo.enhanced
      const label = busy
        ? t('button.busy')
        : error
          ? format(retryable ? t('button.error') : t('button.errorFatal'), { message: error })
          : showUndo
            ? t('button.undo')
            : t('button.enhance')
      const disabled = busy || (typeof draftFromHook === 'string' && draft.trim() === '')

      return h('span', { style: { display: 'inline-flex' } },
        h('button', {
          className: 'dsh-pe-btn',
          type: 'button',
          onClick,
          disabled,
          title: label,
          'aria-label': label,
          'aria-busy': busy,
          'data-error': String(failed),
          'data-undo': String(showUndo),
        },
        busy
          ? h('span', { className: 'dsh-pe-spin' })
          : failed
            ? h('span', { style: { fontSize: 13, fontWeight: 700, lineHeight: '16px' } }, '✕')
            : showUndo
              ? h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                h('path', { d: 'M5.5 4.5L2 8l3.5 3.5' }),
                h('path', { d: 'M2 8h7.5a3.5 3.5 0 010 7H7.5' }))
              : h(SparkleIcon, null)))
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
      try {
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: ID,
          order: -10,
          locale: NS,
        }, (props) => h(EnhanceButton, { ...props, t }))), 'prompt-enhancer: composer button')
      } catch {
        // Hosts without the composer slot simply show no button; the host API still works.
      }
    }

    exports.name = 'prompt-enhancer-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    exports.__test = { ID, DICT, ENDPOINT, EnhanceButton, readDraftFromDom }
    return module.exports
  },
})
