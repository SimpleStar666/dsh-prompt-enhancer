import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Evaluate the shipped browser bundle, not a separately maintained source copy.
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function createDocument() {
  const head = [];
  const body = [];
  const makeElement = (tag) => ({
    tag,
    attributes: {},
    style: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {},
    select() {},
    remove() {
      for (const parent of [head, body]) {
        const index = parent.indexOf(this);
        if (index >= 0) parent.splice(index, 1);
      }
    },
  });
  return {
    head: { appendChild(element) { head.push(element); } },
    body: { appendChild(element) { body.push(element); } },
    createElement: makeElement,
    execCommand: () => true,
    nodes: { head, body },
  };
}

function loadClient({ React = {}, fetch = async () => { throw new Error('Unexpected fetch'); }, clipboard } = {}) {
  const loads = [];
  const document = createDocument();
  const context = createContext({
    window: { __ModuleLoader__: { load: (registration) => loads.push(registration) }, fetch },
    document,
    navigator: { clipboard: clipboard ?? { writeText: async () => {} } },
  });
  runInContext(bundle, context, { filename: 'client.js' });
  assert.equal(loads.length, 1);
  assert.equal(loads[0].id, 'dsh-prompt-enhancer');
  const required = [];
  const client = loads[0].factory((id) => {
    required.push(id);
    assert.equal(id, 'react');
    return React;
  });
  assert.deepEqual(required, ['react']);
  return { client, document };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Minimal deterministic hook runner: state/ref identity, dependency memoization,
// effect cleanup, and React-shaped element trees. No DOM or React dependency.
function hookHarness() {
  const cells = [];
  let cursor = 0;
  let component;
  let props;
  let tree;
  let disposed = false;
  let writesAfterDispose = 0;
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const React = {
    createElement(type, properties, ...children) {
      if (typeof type === 'function') return type({ ...(properties ?? {}), children });
      return { type, props: properties ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) };
    },
    useState(initial) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
      const set = (next) => {
        if (disposed) { writesAfterDispose += 1; return; }
        cells[index].value = typeof next === 'function' ? next(cells[index].value) : next;
      };
      return [cells[index].value, set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { ref: { current: initial } };
      return cells[index].ref;
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!cells[index] || !sameDeps(cells[index].dependencies, dependencies)) {
        cells[index] = { value: factory(), dependencies };
      }
      return cells[index].value;
    },
    useCallback(callback, dependencies) { return React.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!cells[index] || !sameDeps(cells[index].dependencies, dependencies)) {
        cells[index]?.cleanup?.();
        cells[index] = { dependencies, cleanup: effect() };
      }
    },
  };
  const walk = (node, predicate) => {
    if (node == null || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => walk(child, predicate))];
  };
  const text = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') ?? '';
  return {
    React,
    mount(next, nextProps) { component = next; props = nextProps; return this.render(); },
    render() { cursor = 0; tree = component(props); return tree; },
    all(predicate) { return walk(tree, predicate); },
    one(predicate) {
      const found = walk(tree, predicate);
      assert.equal(found.length, 1, 'expected exactly one matching element');
      return found[0];
    },
    button(label) { return this.one((node) => node.type === 'button' && text(node) === label); },
    original() { return this.one((node) => node.type === 'textarea' && node.props.id === 'dsh-prompt-enhancer-original'); },
    draft() { return this.one((node) => node.type === 'textarea' && node.props.id === 'dsh-prompt-enhancer-draft'); },
    answer(id) { return this.one((node) => node.type === 'textarea' && node.props.id === `dsh-prompt-enhancer-answer-${encodeURIComponent(id)}`); },
    text() { return text(tree); },
    dispose() { disposed = true; for (const cell of cells) cell?.cleanup?.(); },
    get writesAfterDispose() { return writesAfterDispose; },
  };
}

function mountPanel({ fetch, clipboard, language = 'en', execCommand } = {}) {
  const harness = hookHarness();
  const { client, document } = loadClient({ React: harness.React, fetch, clipboard });
  if (execCommand) document.execCommand = execCommand;
  const dictionary = client.__test.DICT[language];
  harness.mount(client.__test.EnhancerBody, { t: (key) => dictionary[key] ?? key });
  return harness;
}

const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test('real bundle maps canonical missingQuestions/changeSet and renders descriptions with reasons', () => {
  const { client } = loadClient();
  const { extractResult } = client.__test;
  const result = plain(extractResult({ ok: true, enhancedPrompt: 'clear draft', missingQuestions: ['Who is it for?'],
    changeSet: [
      { type: 'add', section: 'background', description: 'Add background', reason: 'Not provided.' },
      { description: 'Keep constraints' },
      { reason: 'Already explicit.' },
      { description: 'Same', reason: 'Same' },
    ], assumptions: ['Keep intent'], riskFlags: ['missing_background'] }, 'original'));
  assert.deepEqual(result, {
    enhanced: 'clear draft', questions: ['Who is it for?'],
    clarifications: [{ id: 'legacy-1', question: 'Who is it for?', reason: '', evidence: '' }], recognizedFacts: [], reviewNotes: [],
    changes: ['Add background — Not provided.', 'Keep constraints', 'Already explicit.', 'Same'],
    assumptions: ['Keep intent'], risks: ['missing_background'],
  });
  assert.equal(result.changes.some((item) => item.includes('{')), false);
});

test('result extraction supports wrapper/legacy aliases and exact original fallback', () => {
  const { client } = loadClient();
  const { extractResult, normaliseList } = client.__test;
  const original = '  first line\r\n\tsecond line\nlast line  ';
  assert.deepEqual(plain(extractResult(null, original)), { enhanced: original, questions: [], clarifications: [], recognizedFacts: [], reviewNotes: [], assumptions: [], changes: [], risks: [] });
  assert.equal(extractResult({ result: { enhancedPrompt: ' \n ' } }, original).enhanced, original);
  assert.equal(extractResult({ data: { enhancedPrompt: 123 } }, original).enhanced, original);
  assert.deepEqual(plain(extractResult({ data: { enhanced: 'legacy', clarifyingQuestions: [{ question: 'Which audience?' }],
    changeSummary: [{ text: 'Clarified scope' }], assumptions: 'No invented facts', risks: 'ambiguous' } }, original)), {
    enhanced: 'legacy', questions: ['Which audience?'], clarifications: [{ id: 'legacy-1', question: 'Which audience?', reason: '', evidence: '' }],
    recognizedFacts: [], reviewNotes: [], changes: ['Clarified scope'], assumptions: ['No invented facts'], risks: ['ambiguous'],
  });
  assert.deepEqual(plain(extractResult({ result: { draft: 'wrapped', missingQuestions: [], questions: ['ignored'], changeSet: [], changes: ['ignored'] } }, original)), {
    enhanced: 'wrapped', questions: [], clarifications: [], recognizedFacts: [], reviewNotes: [], changes: [], assumptions: [], risks: [],
  });
  assert.deepEqual(plain(normaliseList([null, undefined, '', '  ', { unknown: true }, { label: 'Human label' }, 42])), ['Human label', '42']);
});

test('new result contract keeps verifiable evidence and at most two optional clarifications without treating confidence as quality', () => {
  const { client } = loadClient();
  const original = '  给新同事写一页入门指南，保留术语表。\n';
  const start = original.indexOf('新同事');
  const result = plain(client.__test.extractResult({ result: {
    enhancedPrompt: original,
    recognizedFacts: [
      { key: 'audience', label: '读者', evidence: '新同事', start, end: start + 3 },
      { key: 'format', label: '形式', evidence: '一页入门指南', start: -1, end: 999 },
      { key: 'invented', label: '推断', evidence: '管理层', start: 0, end: 3 },
      { key: 'empty', label: '空证据', evidence: '  ' },
    ],
    clarifications: [
      { id: 'audience-detail', question: '需要哪种背景？', reason: '仅在你希望细化时补充。', evidence: '新同事' },
      { id: 'audience-detail', question: '还有别的限制吗？', reason: '可以留空。', evidence: '' },
      { id: 'third', question: '不应显示第三个问题' },
    ],
    missingQuestions: ['旧问题不覆盖新结构'],
    reviewNotes: ['本地线索识别，不代表缺失或完整判断。'], confidence: 1,
    assumptions: [], changeSet: [], riskFlags: [],
  } }, original));
  assert.equal(result.enhanced, original);
  assert.deepEqual(result.recognizedFacts, [
    { key: 'audience', label: '读者', evidence: '新同事', start, end: start + 3 },
    { key: 'format', label: '形式', evidence: '一页入门指南', start: original.indexOf('一页入门指南'), end: original.indexOf('一页入门指南') + 6 },
  ]);
  assert.equal(result.clarifications.length, 2);
  assert.equal(new Set(result.clarifications.map((item) => item.id)).size, 2);
  assert.deepEqual(result.clarifications[0], { id: 'audience-detail', question: '需要哪种背景？', reason: '仅在你希望细化时补充。', evidence: '新同事' });
  assert.deepEqual(result.reviewNotes, ['本地线索识别，不代表缺失或完整判断。']);
  assert.equal('confidence' in result, false);
  assert.deepEqual(plain(client.__test.extractResult({ clarifications: [], missingQuestions: ['Do not resurrect this question'] }, original).clarifications), []);
});

test('bundle registers dictionaries, style, sidebar type and slot, and all registrations clean up', () => {
  const { client, document } = loadClient();
  const effects = [];
  const registrations = [];
  const cleanups = [];
  let dictionary;
  let tab;
  let slotFactory;
  let slot;
  const register = (kind, value) => {
    registrations.push(kind);
    if (kind === 'tab') tab = value;
    if (kind === 'inject') slotFactory = value;
    if (kind === 'slot') slot = value;
    return () => cleanups.push(kind);
  };
  client.apply({
    effect(effect, label) { effects.push({ label, dispose: effect() }); },
    locale: {
      bind(namespace) { assert.equal(namespace, 'promptEnhancer'); return (key) => dictionary.en[key]; },
      register(namespace, value) { assert.equal(namespace, 'promptEnhancer'); dictionary = value; return register('locale', value); },
    },
    sidebarRightTabs: { register: (value) => register('tab', value) },
    slots: {
      inject(name, factory) { assert.equal(name, 'sidebar.right.pane.tab'); return register('inject', factory); },
      register(options, component) { assert.equal(component, client.__test.EnhancerBody); return register('slot', options); },
    },
  });
  assert.equal(client.name, 'prompt-enhancer-client');
  assert.deepEqual(plain(client.inject), ['slots', 'locale', 'sidebarRightTabs']);
  assert.equal(effects.length, 4);
  assert.equal(document.nodes.head.length, 1);
  assert.equal(document.nodes.head[0].attributes['data-plugin'], 'dsh-prompt-enhancer');
  assert.match(document.nodes.head[0].textContent, /\.pe-textarea/);
  assert.equal(tab.id, 'dsh-prompt-enhancer');
  assert.equal(tab.kind, 'prompt-enhancer');
  assert.equal(tab.title(), 'Idea enhancer');
  assert.equal(tab.guide[0].title(), 'Idea enhancer');
  const disposeSlot = slotFactory();
  assert.equal(slot.name, 'sidebar.right.pane.tab');
  assert.equal(slot.key, 'dsh-prompt-enhancer');
  assert.deepEqual(plain(slot.inject('session-test')), { sessionId: 'session-test' });
  disposeSlot();
  for (const effect of effects.toReversed()) effect.dispose?.();
  assert.deepEqual(registrations, ['locale', 'tab', 'inject', 'slot']);
  assert.deepEqual(cleanups, ['slot', 'inject', 'tab', 'locale']);
  assert.equal(document.nodes.head.length, 0);
});

test('busy state locks clear/edit and duplicate requests; new enhancement hides old results', async () => {
  const requests = [];
  const pending = [];
  const panel = mountPanel({ fetch: (path, init) => {
    requests.push({ path, init });
    const task = deferred(); pending.push(task); return task.promise;
  } });
  const original = '  first line\r\n\tsecond line\nlast line  ';
  panel.original().props.onChange({ target: { value: original } });
  panel.render();
  const originalEdit = panel.original().props.onChange;
  const clear = panel.button('Clear').props.onClick;
  const enhance = panel.button('Review idea').props.onClick;
  const work = enhance();
  // Exercise stale callbacks even before the disabled props have rerendered.
  clear();
  originalEdit({ target: { value: 'must not replace pending original' } });
  await enhance();
  panel.render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/prompt-enhancer/enhance');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: original, idea: original, profile: 'general' });
  assert.equal(panel.original().props.value, original);
  assert.equal(panel.original().props.disabled, true);
  assert.equal(panel.all((node) => node.type === 'select').length, 0, 'no profile selector may imply an unsupported style effect');
  assert.equal(panel.button('Clear').props.disabled, true);
  assert.equal(panel.button('Reviewing…').props.disabled, true);
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  pending[0].resolve(response({ ok: true, enhancedPrompt: 'First draft', missingQuestions: ['A question'], changeSet: [{ description: 'A change', reason: 'A reason' }] }));
  await work;
  panel.render();
  assert.equal(panel.draft().props.value, 'First draft');
  assert.match(panel.text(), /A change — A reason/);
  assert.match(panel.text(), /A question/);
  const oldUndo = panel.button('Undo enhancement').props.onClick;
  const oldAccept = panel.button('Confirm draft').props.onClick;
  const oldDraftEdit = panel.draft().props.onChange;
  const oldCopy = panel.button('Copy').props.onClick;
  const next = panel.button('Review idea').props.onClick();
  oldUndo(); oldAccept(); oldDraftEdit({ target: { value: 'stale draft edit' } }); await oldCopy();
  clear();
  panel.render();
  assert.equal(requests.length, 2);
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  assert.equal(panel.all((node) => node.type === 'button' && ['Confirm draft', 'Undo enhancement'].includes(node.children[0])).length, 0);
  assert.doesNotMatch(panel.text(), /A change|A question|Confirmed;/);
  assert.equal(panel.original().props.value, original);
  pending[1].resolve(response({ ok: true, enhancedPrompt: 'Second draft' }));
  await next;
  panel.render();
  assert.equal(panel.draft().props.value, 'Second draft');
  assert.equal(panel.button('Clear').props.disabled, false);
});

test('confirmation never fills/sends; editable draft copies exactly; undo restores exact multiline original', async () => {
  const copied = [];
  const submitted = [];
  const panel = mountPanel({ fetch: async (_path, init) => { submitted.push(JSON.parse(init.body)); return response({ ok: true, enhancedPrompt: 'Enhanced' }); }, clipboard: { writeText: async (text) => { copied.push(text); } } });
  const original = '\n  first\r\n\tsecond\n\nthird  \n';
  panel.original().props.onChange({ target: { value: original } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  assert.match(panel.text(), /Copy it and paste it into the input yourself; nothing is backfilled or sent automatically/);
  panel.draft().props.onChange({ target: { value: 'Edited\n  draft  ' } }); panel.render();
  panel.button('Confirm draft').props.onClick(); panel.render();
  assert.equal(panel.original().props.value, original);
  assert.match(panel.text(), /Confirmed; copy and paste it yourself/);
  assert.equal(submitted.length, 1);
  assert.deepEqual(copied, []);
  await panel.button('Copy').props.onClick(); panel.render();
  assert.deepEqual(copied, ['Edited\n  draft  ']);
  panel.button('Undo enhancement').props.onClick(); panel.render();
  assert.equal(panel.original().props.value, original);
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  assert.match(panel.text(), /Restore original/);
  // The next enhance request also gets exactly the restored original.
  await panel.button('Review idea').props.onClick(); panel.render();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].text, original);
  panel.button('Clear').props.onClick(); panel.render();
  assert.equal(panel.original().props.value, '');
  assert.doesNotMatch(panel.text(), /Restore original|Confirmed;/);
});

test('original edits invalidate old result and confirmation rather than pairing it with another idea', async () => {
  const panel = mountPanel({ fetch: async () => response({ enhancedPrompt: 'Old draft' }) });
  panel.original().props.onChange({ target: { value: 'Old idea' } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  panel.button('Confirm draft').props.onClick(); panel.render();
  panel.original().props.onChange({ target: { value: 'New\n idea  ' } }); panel.render();
  assert.equal(panel.original().props.value, 'New\n idea  ');
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  assert.doesNotMatch(panel.text(), /Confirmed;/);
});

test('failed enhancement keeps exact original, clears stale result, and re-enables clear/retry', async () => {
  let calls = 0;
  const panel = mountPanel({ fetch: async () => ++calls === 1 ? response({ enhancedPrompt: 'Old draft' }) : response({ ok: false, error: 'Service unavailable' }, 503) });
  const original = '  keep\n\tthese lines  ';
  panel.original().props.onChange({ target: { value: original } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  assert.equal(panel.original().props.value, original);
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  assert.match(panel.text(), /Enhancement failed: Service unavailable/);
  assert.equal(panel.button('Clear').props.disabled, false);
  assert.equal(panel.button('Retry').props.disabled, false);
});

test('a late clipboard completion cannot replace the undo notice', async () => {
  const clipboard = deferred();
  const panel = mountPanel({ fetch: async () => response({ enhancedPrompt: 'Draft' }), clipboard: { writeText: () => clipboard.promise } });
  panel.original().props.onChange({ target: { value: 'Original\n  exact  ' } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  const copying = panel.button('Copy').props.onClick();
  panel.button('Undo enhancement').props.onClick(); panel.render();
  clipboard.resolve();
  await copying; panel.render();
  assert.match(panel.text(), /Restore original/);
  assert.doesNotMatch(panel.text(), /Copied/);
});

test('unmount invalidates an in-flight response without state writes after disposal', async () => {
  const pending = deferred();
  const panel = mountPanel({ fetch: () => pending.promise });
  panel.original().props.onChange({ target: { value: 'Idea' } }); panel.render();
  const work = panel.button('Review idea').props.onClick();
  panel.dispose();
  pending.resolve(response({ enhancedPrompt: 'Too late' }));
  await work;
  assert.equal(panel.writesAfterDispose, 0);
});

test('clipboard fallback failure is reported and empty edited draft never copies the original', async () => {
  const copied = [];
  const panel = mountPanel({
    fetch: async () => response({ enhancedPrompt: 'Draft' }),
    clipboard: { writeText: async (text) => { copied.push(text); throw new Error('Denied'); } },
    execCommand: () => false,
  });
  panel.original().props.onChange({ target: { value: 'Original' } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  await panel.button('Copy').props.onClick(); panel.render();
  assert.match(panel.text(), /Copy failed/);
  panel.draft().props.onChange({ target: { value: '' } }); panel.render();
  await panel.button('Copy').props.onClick();
  assert.deepEqual(copied, ['Draft']);
});

test('evidence-first UI quotes the original, displays review notes and optional reasons, and gives all textareas distinct IDs', async () => {
  const original = '  为新同事写一页指南。\n';
  const panel = mountPanel({ language: 'zh', fetch: async () => response({
    enhancedPrompt: original,
    recognizedFacts: [{ key: 'audience', label: '读者', evidence: '新同事', start: 3, end: 6 }],
    clarifications: [{ id: 'context/detail', question: '需要补充哪种背景？', reason: '仅在你希望细化时回答。', evidence: '新同事' }],
    reviewNotes: ['这是本地线索识别，不代表缺失或完整判断。'],
    missingQuestions: ['这个旧问题不应重复显示'], assumptions: [], changeSet: [], riskFlags: [], confidence: 0.99,
  }) });
  panel.original().props.onChange({ target: { value: original } }); panel.render();
  await panel.button('分析想法').props.onClick(); panel.render();
  assert.equal(panel.draft().props.value, original);
  assert.match(panel.text(), /原文已保留/);
  assert.match(panel.text(), /本地线索整理；不调用模型，也不会用模型重写/);
  assert.match(panel.text(), /原文中已表达读者新同事/);
  assert.equal(panel.one((node) => node.type === 'blockquote').children[0], '新同事');
  assert.match(panel.text(), /这是本地线索识别，不代表缺失或完整判断/);
  assert.match(panel.text(), /可选澄清需要补充哪种背景？仅在你希望细化时回答/);
  assert.doesNotMatch(panel.text(), /0\.99|confidence|置信|质量|这个旧问题|增强成功|暂无/);
  assert.equal(panel.all((node) => node.type === 'h3' && node.children[0] === '假设（如有）').length, 0);
  const ids = panel.all((node) => node.type === 'textarea').map((node) => node.props.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(Boolean));
  assert.equal(panel.answer('context/detail').props.value, '');
  assert.equal(panel.answer('context/detail').props.required, undefined);
  assert.equal(panel.button('将回答加入草稿').props.disabled, true);
});

test('empty questions and optional lists render no empty cards with either new or old APIs', async () => {
  for (const payload of [{ clarifications: [], recognizedFacts: [], reviewNotes: [], missingQuestions: ['ignored compatibility question'] }, {}]) {
    const panel = mountPanel({ fetch: async () => response(payload) });
    const original = '  Keep exact original\n';
    panel.original().props.onChange({ target: { value: original } }); panel.render();
    await panel.button('Review idea').props.onClick(); panel.render();
    assert.equal(panel.draft().props.value, original);
    assert.match(panel.text(), /Original preserved/);
    assert.equal(panel.all((node) => node.type === 'section').length, 0);
    assert.equal(panel.all((node) => node.type === 'textarea').length, 2);
    assert.doesNotMatch(panel.text(), /Optional clarifications|Assumptions|Change summary|Risk flags|None|ignored compatibility question/);
    assert.equal(panel.all((node) => node.type === 'button' && node.children[0] === 'Add answers to draft').length, 0);
  }
});

test('only nonempty user answers append once to the current draft, preserving original and manual edits', async () => {
  const original = '\n  第一行\r\n\t第二行\n';
  const copied = [];
  const panel = mountPanel({ language: 'zh', fetch: async () => response({ enhancedPrompt: original,
    clarifications: [
      { id: 'audience', question: '面向谁？', reason: '例如：管理层（不是用户答案）', evidence: '' },
      { id: 'scope', question: '哪些范围？', reason: '可选。', evidence: '' },
    ],
  }), clipboard: { writeText: async (text) => { copied.push(text); } } });
  panel.original().props.onChange({ target: { value: original } }); panel.render();
  await panel.button('分析想法').props.onClick(); panel.render();
  const edited = `${original}\n用户手工编辑的草稿尾部`;
  panel.draft().props.onChange({ target: { value: edited } });
  panel.answer('audience').props.onChange({ target: { value: '新同事\n  需要术语表' } });
  panel.answer('scope').props.onChange({ target: { value: ' \n\t' } }); panel.render();
  assert.equal(panel.button('将回答加入草稿').props.disabled, false);
  const add = panel.button('将回答加入草稿').props.onClick;
  add(); add(); panel.render();
  const expected = `${edited}\n\n补充说明\n- 面向谁？\n  新同事\n    需要术语表`;
  assert.equal(panel.draft().props.value, expected);
  assert.equal(panel.original().props.value, original);
  assert.doesNotMatch(panel.draft().props.value, /哪些范围|管理层|可选|待补充|用户答案/);
  assert.equal(panel.button('将回答加入草稿').props.disabled, true);
  assert.equal(panel.answer('audience').props.disabled, true);
  assert.match(panel.text(), /如需修改，请直接编辑草稿。不会重复追加/);
  panel.draft().props.onChange({ target: { value: `${expected}\n手改补充` } }); panel.render();
  add(); panel.render();
  assert.equal(panel.draft().props.value, `${expected}\n手改补充`);
  await panel.button('复制').props.onClick();
  assert.deepEqual(copied, [`${expected}\n手改补充`]);
});

test('two answers preserve question order and safely support IDs matching object prototype names', async () => {
  const panel = mountPanel({ fetch: async () => response({ clarifications: [
    { id: '__proto__', question: 'First?', reason: 'Optional.' },
    { id: 'constructor', question: 'Second?', reason: 'Optional.' },
  ] }) });
  panel.original().props.onChange({ target: { value: 'Original' } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  assert.equal(panel.answer('__proto__').props.value, '');
  assert.equal(panel.answer('constructor').props.value, '');
  panel.answer('constructor').props.onChange({ target: { value: 'Second answer' } });
  panel.answer('__proto__').props.onChange({ target: { value: 'First answer' } }); panel.render();
  panel.button('Add answers to draft').props.onClick(); panel.render();
  assert.equal(panel.draft().props.value, 'Original\n\nAdditional context\n- First?\n  First answer\n- Second?\n  Second answer');
});

test('blank answers never consume the one-time apply and legacy questions are still answerable', async () => {
  const original = 'Legacy original';
  const panel = mountPanel({ fetch: async () => response({ missingQuestions: ['Which audience?'] }) });
  panel.original().props.onChange({ target: { value: original } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  const blankAdd = panel.button('Add answers to draft').props.onClick;
  panel.answer('legacy-1').props.onChange({ target: { value: '  \n ' } }); panel.render();
  panel.button('Add answers to draft').props.onClick(); panel.render();
  assert.equal(panel.draft().props.value, original);
  assert.equal(panel.button('Add answers to draft').props.disabled, true);
  panel.answer('legacy-1').props.onChange({ target: { value: 'New colleagues' } }); panel.render();
  assert.equal(panel.button('Add answers to draft').props.disabled, false);
  // A retained empty-answer callback must not invent a response.
  blankAdd(); panel.render();
  assert.equal(panel.draft().props.value, original);
  panel.button('Add answers to draft').props.onClick(); panel.render();
  assert.equal(panel.draft().props.value, `${original}\n\nAdditional context\n- Which audience?\n  New colleagues`);
});

test('enhance, clear, undo and original edits reset both answers and the applied lock', async () => {
  const panel = mountPanel({ fetch: async (_path, init) => response({ enhancedPrompt: JSON.parse(init.body).text,
    clarifications: [{ id: 'detail', question: 'Any detail?', reason: 'Optional.', evidence: '' }],
  }) });
  panel.original().props.onChange({ target: { value: 'Original' } }); panel.render();
  await panel.button('Review idea').props.onClick(); panel.render();
  for (const action of ['enhance', 'clear', 'undo', 'original edit']) {
    assert.equal(panel.answer('detail').props.value, '', action);
    assert.equal(panel.answer('detail').props.disabled, false, action);
    assert.equal(panel.button('Add answers to draft').props.disabled, true, action);
    panel.answer('detail').props.onChange({ target: { value: `Answer before ${action}` } }); panel.render();
    const oldAdd = panel.button('Add answers to draft').props.onClick;
    const oldAnswerEdit = panel.answer('detail').props.onChange;
    oldAdd(); panel.render();
    assert.equal(panel.button('Add answers to draft').props.disabled, true);
    if (action === 'enhance') {
      await panel.button('Review idea').props.onClick(); panel.render();
    } else {
      if (action === 'clear') { panel.button('Clear').props.onClick(); panel.render(); panel.original().props.onChange({ target: { value: 'After clear' } }); panel.render(); }
      if (action === 'undo') { panel.button('Undo enhancement').props.onClick(); panel.render(); }
      if (action === 'original edit') { panel.original().props.onChange({ target: { value: 'Edited original' } }); panel.render(); }
      assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
      await panel.button('Review idea').props.onClick(); panel.render();
    }
    // Old callbacks cannot repopulate answers or append to a later result.
    oldAnswerEdit({ target: { value: 'stale answer' } }); oldAdd(); panel.render();
    assert.equal(panel.answer('detail').props.value, '', action);
    assert.equal(panel.draft().props.value, panel.original().props.value, action);
    assert.equal(panel.button('Add answers to draft').props.disabled, true, action);
    assert.doesNotMatch(panel.text(), /Answers added to this draft/);
  }
});

test('busy and result revisions lock retained answer callbacks before and after a new request', async () => {
  const pending = [];
  const panel = mountPanel({ fetch: () => { const task = deferred(); pending.push(task); return task.promise; } });
  panel.original().props.onChange({ target: { value: 'Original' } }); panel.render();
  const first = panel.button('Review idea').props.onClick();
  pending[0].resolve(response({ clarifications: [{ id: 'context', question: 'Context?', reason: 'Optional.' }] }));
  await first; panel.render();
  panel.answer('context').props.onChange({ target: { value: 'Old answer' } }); panel.render();
  const oldAdd = panel.button('Add answers to draft').props.onClick;
  const oldAnswerEdit = panel.answer('context').props.onChange;
  const second = panel.button('Review idea').props.onClick();
  oldAnswerEdit({ target: { value: 'Not while busy' } }); oldAdd(); panel.render();
  assert.equal(panel.all((node) => node.type === 'textarea').length, 1);
  pending[1].resolve(response({ clarifications: [{ id: 'context', question: 'New context?', reason: 'Optional.' }] }));
  await second; panel.render();
  oldAnswerEdit({ target: { value: 'Not after result changed' } }); oldAdd(); panel.render();
  assert.equal(panel.answer('context').props.value, '');
  assert.equal(panel.draft().props.value, 'Original');
  assert.equal(panel.button('Add answers to draft').props.disabled, true);
});

test('Chinese and English review buttons and confirmation hints accurately describe local review and manual copy/paste', () => {
  const { client } = loadClient();
  assert.equal(client.__test.DICT.zh.enhance, '分析想法');
  assert.equal(client.__test.DICT.zh.enhancing, '分析中…');
  assert.equal(client.__test.DICT.en.enhance, 'Review idea');
  assert.equal(client.__test.DICT.en.enhancing, 'Reviewing…');
  assert.equal(client.__test.DICT.zh.accept, '确认增强稿');
  assert.equal(client.__test.DICT.en.accept, 'Confirm draft');
  assert.match(client.__test.DICT.zh.hint, /复制后自行粘贴/);
  assert.match(client.__test.DICT.zh.hint, /不会自动回填或发送/);
  assert.doesNotMatch(bundle, /接受回填|Accept backfill/);
});
