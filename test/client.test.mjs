import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Evaluate the shipped browser bundle, not a separately maintained source copy.
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

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

function loadClient({ React = {}, fetch = async () => { throw new Error('Unexpected fetch'); } } = {}) {
  const loads = [];
  const document = createDocument();
  const context = createContext({
    window: { __ModuleLoader__: { load: (registration) => loads.push(registration) }, fetch },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
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
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!cells[index] || !sameDeps(cells[index].dependencies, dependencies)) {
        cells[index] = { value: callback, dependencies };
      }
      return cells[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!cells[index] || !sameDeps(cells[index].dependencies, dependencies)) {
        cells[index]?.cleanup?.();
        const cleanup = effect();
        cells[index] = { cleanup: typeof cleanup === 'function' ? cleanup : undefined, dependencies };
      }
      return undefined;
    },
  };
  const mount = (Component, initialProps) => {
    component = Component;
    props = initialProps;
    tree = render();
    return tree;
  };
  const render = () => {
    cursor = 0;
    return component({ ...props, children: [] });
  };
  const rerender = (nextProps) => {
    props = { ...props, ...nextProps };
    tree = render();
    return tree;
  };
  const dispose = () => {
    disposed = true;
    // Real React runs effect cleanups on unmount; the bundle relies on that to
    // invalidate in-flight responses.
    for (const cell of cells) {
      cell?.cleanup?.();
      cell.cleanup = undefined;
    }
    cursor = 0;
    tree = null;
  };
  return { React, mount, rerender, dispose, get writesAfterDispose() { return writesAfterDispose; } };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  const own = typeof node.props?.title === 'string' ? node.props.title : '';
  const children = Array.isArray(node.children) ? node.children.map(textOf).join('') : '';
  return own + children;
}

function findButton(node, predicate) {
  if (node === null || node === undefined || node === false) return null;
  if (node.type === 'button' && (predicate === undefined || predicate(node))) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findButton(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

const t = (key, values) => {
  if (values && values.message !== undefined) return `${key}:${values.message}`;
  if (key === 'button.error') return 'button.error:{message}';
  return key;
};

test('bundle registers dictionaries, style, and the composer button slot with cleanup', () => {
  const dictionaries = [];
  const effects = [];
  const disposers = [];
  const registrations = [];
  const cleanups = [];
  const { client, document } = loadClient({
    React: { createElement() {}, useCallback() {}, useEffect() {}, useMemo() {}, useState() {} },
  });
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale']);
  const ctx = {
    locale: {
      bind(namespace) { assert.equal(namespace, 'promptEnhancer'); return t; },
      register(namespace, dictionary) { dictionaries.push({ namespace, dictionary }); return () => cleanups.push('locale'); },
    },
    effect(effect, label) {
      effects.push(label);
      const dispose = effect();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'conversation.input.right');
        factory();
        return () => cleanups.push('slot');
      },
      register(slot, component) {
        assert.equal(typeof component, 'function');
        registrations.push(slot);
        return () => cleanups.push('slot-register');
      },
    },
  };
  client.apply(ctx);
  assert.equal(effects.length, 3);
  assert.equal(registrations.length, 1);
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, 'promptEnhancer');
  assert.equal(registrations[0].name, 'conversation.input.right');
  assert.equal(registrations[0].id, 'dsh-prompt-enhancer');
  assert.equal(registrations[0].order, -10);
  assert.equal(registrations[0].locale, 'promptEnhancer');
  assert.equal(document.nodes.head.length, 1, 'one style node injected');
  // No sidebar tab is registered by the one-click client.
  assert.equal(ctx.sidebarRightTabs, undefined);
});

test('button renders nothing when the host gives no input actions', () => {
  const { client } = loadClient({ React: hookHarness().React });
  const harness = hookHarness();
  const component = client.__test.EnhanceButton;
  const tree = harness.mount(component, { sessionId: 's1', t });
  assert.equal(tree, null);
});

test('button is disabled for an empty draft and never fetches', async () => {
  const { client } = loadClient({ React: hookHarness().React });
  const harness = hookHarness();
  const setDraft = () => { throw new Error('setDraft must not run'); };
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft }, useInput: () => '', t });
  const button = findButton(tree);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props['aria-busy'], false);
  harness.dispose();
});

test('one click fetches, writes the enhanced draft back and offers exact undo', async () => {
  const harness = hookHarness();
  const calls = [];
  const responses = [];
  const writes = [];
  let draft = '写个周报';
  const fetch = async (path, init) => {
    calls.push({ path, init });
    const pending = deferred();
    responses.push(pending);
    return pending.promise;
  };
  const { client } = loadClient({ React: harness.React, fetch });
  const useInput = () => draft;
  const setDraft = (value) => { draft = value; writes.push(value); };
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft }, useInput, t });
  const button = findButton(tree);
  assert.equal(button.props.disabled, false);
  const clicking = button.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/prompt-enhancer/enhance');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: '写个周报', sessionId: 's1' });
  assert.equal(findButton(harness.rerender({})).props['aria-busy'], true);
  const settled = deferred();
  responses[0].resolve({ ok: true, status: 200, json: async () => settled.promise });
  settled.resolve({ ok: true, enhancedPrompt: '写一份给团队看的项目周报，覆盖本周进展、风险与下周计划。' });
  await clicking;
  const after = findButton(harness.rerender({ useInput }));
  assert.equal(draft, '写一份给团队看的项目周报，覆盖本周进展、风险与下周计划。');
  assert.deepEqual(writes, ['写一份给团队看的项目周报，覆盖本周进展、风险与下周计划。']);
  assert.match(after.props.title, /button\.undo/);
  await after.props.onClick();
  assert.equal(draft, '写个周报');
  assert.deepEqual(writes[1], '写个周报');
  harness.dispose();
});

test('without a draft hook the button stays enabled and reports empty on click', async () => {
  const harness = hookHarness();
  const { client } = loadClient({ React: harness.React, fetch: async () => { throw new Error('must not fetch'); } });
  // No [data-composer-input] element: DOM fallback reads nothing.
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft() {} }, t });
  const button = findButton(tree);
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  const after = findButton(harness.rerender({}));
  assert.equal(after.props['data-error'], 'true');
  assert.match(after.props.title, /button\.empty/);
  harness.dispose();
});

test('a failed request keeps the draft untouched and reports a retryable error', async () => {
  const harness = hookHarness();
  const fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: '没有可用的模型路由' }) });
  const { client } = loadClient({ React: harness.React, fetch });
  const writes = [];
  const setDraft = (value) => { writes.push(value); };
  let draft = '写个周报';
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft }, useInput: () => draft, t });
  const button = findButton(tree);
  await button.props.onClick();
  assert.deepEqual(writes, []);
  const after = findButton(harness.rerender({}));
  assert.match(after.props.title, /没有可用的模型路由/);
  assert.equal(after.props['data-error'], 'true');
  harness.dispose();
});

test('a stale response never writes after unmount', async () => {
  const harness = hookHarness();
  const pending = [];
  const fetch = async () => {
    const p = deferred();
    pending.push(p);
    return p.promise;
  };
  const { client } = loadClient({ React: harness.React, fetch });
  const writes = [];
  const setDraft = (value) => { writes.push(value); };
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft }, useInput: () => '写个周报', t });
  const first = findButton(tree).props.onClick();
  assert.equal(pending.length, 1);
  harness.dispose();
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ ok: true, enhancedPrompt: '不该写入' }) });
  await Promise.allSettled([first]);
  assert.deepEqual(writes, []);
  assert.equal(harness.writesAfterDispose, 0);
});

test('duplicate clicks while busy do not issue another request', async () => {
  const harness = hookHarness();
  let calls = 0;
  const pending = [];
  const fetch = async () => {
    calls += 1;
    const p = deferred();
    pending.push(p);
    return p.promise;
  };
  const { client } = loadClient({ React: harness.React, fetch });
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft() {} }, useInput: () => '写个周报', t });
  const button = findButton(tree);
  const first = button.props.onClick();
  await findButton(harness.rerender({})).props.onClick();
  assert.equal(calls, 1);
  pending[0]?.resolve({ ok: true, status: 200, json: async () => ({ ok: true, enhancedPrompt: 'x' }) });
  await first;
  harness.dispose();
});

test('editing the draft after enhancement invalidates undo', async () => {
  const harness = hookHarness();
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, enhancedPrompt: '增强版' }) });
  const { client } = loadClient({ React: harness.React, fetch });
  let draft = '写个周报';
  const tree = harness.mount(client.__test.EnhanceButton, { sessionId: 's1', inputActions: { setDraft(v) { draft = v; } }, useInput: () => draft, t });
  await findButton(tree).props.onClick();
  assert.equal(draft, '增强版');
  assert.match(findButton(harness.rerender({})).props.title, /button\.undo/);
  draft = '用户手改后的草稿';
  const edited = findButton(harness.rerender({}));
  assert.match(edited.props.title, /button\.enhance/);
  harness.dispose();
});
