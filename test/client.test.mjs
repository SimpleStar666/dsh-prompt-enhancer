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
    draft() { return this.one((node) => node.type === 'textarea' && !node.props.id); },
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
    changes: ['Add background — Not provided.', 'Keep constraints', 'Already explicit.', 'Same'],
    assumptions: ['Keep intent'], risks: ['missing_background'],
  });
  assert.equal(result.changes.some((item) => item.includes('{')), false);
});

test('result extraction supports wrapper/legacy aliases and exact original fallback', () => {
  const { client } = loadClient();
  const { extractResult, normaliseList } = client.__test;
  const original = '  first line\r\n\tsecond line\nlast line  ';
  assert.deepEqual(plain(extractResult(null, original)), { enhanced: original, questions: [], assumptions: [], changes: [], risks: [] });
  assert.equal(extractResult({ result: { enhancedPrompt: ' \n ' } }, original).enhanced, original);
  assert.equal(extractResult({ data: { enhancedPrompt: 123 } }, original).enhanced, original);
  assert.deepEqual(plain(extractResult({ data: { enhanced: 'legacy', clarifyingQuestions: [{ question: 'Which audience?' }],
    changeSummary: [{ text: 'Clarified scope' }], assumptions: 'No invented facts', risks: 'ambiguous' } }, original)), {
    enhanced: 'legacy', questions: ['Which audience?'], changes: ['Clarified scope'], assumptions: ['No invented facts'], risks: ['ambiguous'],
  });
  assert.deepEqual(plain(extractResult({ result: { draft: 'wrapped', missingQuestions: [], questions: ['ignored'], changeSet: [], changes: ['ignored'] } }, original)), {
    enhanced: 'wrapped', questions: [], changes: [], assumptions: [], risks: [],
  });
  assert.deepEqual(plain(normaliseList([null, undefined, '', '  ', { unknown: true }, { label: 'Human label' }, 42])), ['Human label', '42']);
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

test('busy state locks clear/edit/profile and duplicate requests; new enhancement hides old results', async () => {
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
  const enhance = panel.button('Enhance').props.onClick;
  const profileEdit = panel.one((node) => node.type === 'select').props.onChange;
  const work = enhance();
  // Exercise stale callbacks even before the disabled props have rerendered.
  clear();
  originalEdit({ target: { value: 'must not replace pending original' } });
  profileEdit({ target: { value: 'coding' } });
  await enhance();
  panel.render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/prompt-enhancer/enhance');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: original, idea: original, profile: 'general' });
  assert.equal(panel.original().props.value, original);
  assert.equal(panel.original().props.disabled, true);
  assert.equal(panel.one((node) => node.type === 'select').props.disabled, true);
  assert.equal(panel.one((node) => node.type === 'select').props.value, 'general');
  assert.equal(panel.button('Clear').props.disabled, true);
  assert.equal(panel.button('Enhancing…').props.disabled, true);
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
  const next = panel.button('Enhance').props.onClick();
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
  await panel.button('Enhance').props.onClick(); panel.render();
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
  await panel.button('Enhance').props.onClick(); panel.render();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].text, original);
  panel.button('Clear').props.onClick(); panel.render();
  assert.equal(panel.original().props.value, '');
  assert.doesNotMatch(panel.text(), /Restore original|Confirmed;/);
});

test('original edits invalidate old result and confirmation rather than pairing it with another idea', async () => {
  const panel = mountPanel({ fetch: async () => response({ enhancedPrompt: 'Old draft' }) });
  panel.original().props.onChange({ target: { value: 'Old idea' } }); panel.render();
  await panel.button('Enhance').props.onClick(); panel.render();
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
  await panel.button('Enhance').props.onClick(); panel.render();
  await panel.button('Enhance').props.onClick(); panel.render();
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
  await panel.button('Enhance').props.onClick(); panel.render();
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
  const work = panel.button('Enhance').props.onClick();
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
  await panel.button('Enhance').props.onClick(); panel.render();
  await panel.button('Copy').props.onClick(); panel.render();
  assert.match(panel.text(), /Copy failed/);
  panel.draft().props.onChange({ target: { value: '' } }); panel.render();
  await panel.button('Copy').props.onClick();
  assert.deepEqual(copied, ['Draft']);
});

test('Chinese and English confirmation labels and hints accurately describe manual copy/paste', () => {
  const { client } = loadClient();
  assert.equal(client.__test.DICT.zh.accept, '确认增强稿');
  assert.equal(client.__test.DICT.en.accept, 'Confirm draft');
  assert.match(client.__test.DICT.zh.hint, /复制后自行粘贴/);
  assert.match(client.__test.DICT.zh.hint, /不会自动回填或发送/);
  assert.doesNotMatch(bundle, /接受回填|Accept backfill/);
});
