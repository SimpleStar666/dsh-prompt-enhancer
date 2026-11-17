/**
 * Dependency-free distribution contract checks. Run with:
 *   node tools/check-plugin-contract.mjs
 *   node --test test/package.test.mjs  (also verifies a real pack when available)
 *
 * The browser/HTTP checks use small host mocks, not a running DSH installation.
 */
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script, createContext } from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXPECTED_NAME = 'dsh-prompt-enhancer';
const SIDEBAR_PROVIDER = '@deepseek-ai/dsh-client-ui-sidebar-right';
const posixPath = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');

export function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(join(directory, entry.name), relative) : [relative];
  });
}

export function requiredPackageFiles(directory) {
  const modules = existsSync(join(directory, 'src'))
    ? listFiles(join(directory, 'src'), 'src').filter((file) => file.endsWith('.mjs')) : [];
  return [
    'index.js', 'client.js', 'src/enhancer.mjs', 'src/schema.mjs', 'src/plugin.mjs',
    ...modules, 'README.md', 'LICENSE', 'docs/DETAIL.md', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg',
  ].filter((file, index, files) => files.indexOf(file) === index);
}

/**
 * Deliberately conservative npm-files subset: literal files/directories and
 * *, **, ? globs. Unknown syntax fails instead of claiming npm equivalence.
 * A real package-manager tarball check lives in test/package.test.mjs.
 */
export function isFileCovered(file, entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0, 'package.files must be a non-empty array');
  const candidate = posixPath(file);
  let included = false;
  for (const entry of entries) {
    assert.equal(typeof entry, 'string', 'package.files entries must be strings');
    const excluded = entry.startsWith('!');
    const pattern = posixPath(excluded ? entry.slice(1) : entry);
    assert.ok(pattern && !pattern.startsWith('/') && !pattern.split('/').includes('..'), `unsafe files entry: ${entry}`);
    assert.doesNotMatch(pattern, /[\[\]{}()]/, `unsupported files glob: ${entry}; use literal paths or *, **, ?`);
    let expression = '';
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === '*' && pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
        else expression += '.*';
      } else if (char === '*') expression += '[^/]*';
      else if (char === '?') expression += '[^/]';
      else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    // Directory entries (including globbed directories) include their descendants.
    if (new RegExp(`^${expression}(?:/.*)?$`).test(candidate)) included = !excluded;
  }
  return included;
}

export function assertPackageCoverage(pkg, required) {
  for (const file of required) {
    assert.ok(isFileCovered(file, pkg.files), `package.files does not cover ${file}`);
  }
}

/** Check this bundle's simple insert patch, accepting valid quoted YAML scalars. */
export function assertPatchContract(patch) {
  const lines = patch.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, ''));
  const scalar = (key) => lines.flatMap((line) => {
    const match = line.match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(['"]?)([^'"\\s]+)\\1\\s*$`));
    return match ? [match[2]] : [];
  });
  assert.ok(lines.some((line) => /^\s*-\s*insert:\s*$/.test(line)), 'patch must contain an insert operation');
  assert.deepEqual(scalar('id'), [EXPECTED_NAME]);
  assert.deepEqual(scalar('name'), [EXPECTED_NAME]);
}

/** Execute the actual browser artifact with only the ModuleLoader/React contracts. */
export function inspectClient(source, filename = 'client.js') {
  const registrations = [];
  const documentNodes = [];
  const document = {
    createElement() {
      return { setAttribute() {}, remove() {}, style: {}, textContent: '' };
    },
    head: { appendChild(node) { documentNodes.push(node); } },
  };
  const sandbox = createContext({
    document,
    window: {
      __ModuleLoader__: { load(registration) { registrations.push(registration); } },
      fetch() { throw new Error('client bootstrap must not issue network requests'); },
    },
  });
  // Compilation also rejects browser syntax errors; no source-text regex matching.
  new Script(source, { filename }).runInContext(sandbox, { timeout: 1000 });
  assert.equal(registrations.length, 1, 'client must call ModuleLoader.load exactly once');
  const registration = registrations[0];
  assert.equal(registration.id, EXPECTED_NAME);
  assert.equal(typeof registration.factory, 'function');
  sandbox.__registration = registration;
  sandbox.__require = (specifier) => {
    assert.equal(specifier, 'react', `unexpected client runtime dependency: ${specifier}`);
    return { createElement() {}, useCallback() {}, useEffect() {}, useMemo() {}, useState() {} };
  };
  const plugin = new Script('__registration.factory(__require)', { filename }).runInContext(sandbox, { timeout: 1000 });
  assert.equal(typeof plugin?.apply, 'function', 'client factory must export apply');
  assert.ok(Array.isArray(plugin.inject), 'client inject must be an array');
  for (const service of ['locale', 'slots', 'sidebarRightTabs']) {
    assert.ok(plugin.inject.includes(service), `client inject omits ${service}`);
  }
  const tabs = [];
  const slots = [];
  const dictionaries = [];
  const disposers = [];
  const ctx = {
    effect(effect) {
      const dispose = effect();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    locale: {
      bind() { return (key) => key; },
      register(namespace, dictionary) { dictionaries.push({ namespace, dictionary }); return () => {}; },
    },
    sidebarRightTabs: { register(tab) { tabs.push(tab); return () => {}; } },
    slots: {
      inject(name, effect) { assert.equal(name, 'sidebar.right.pane.tab'); return effect(); },
      register(slot, component) { slots.push({ slot, component }); return () => {}; },
    },
  };
  sandbox.__plugin = plugin;
  sandbox.__ctx = ctx;
  new Script('__plugin.apply(__ctx)', { filename }).runInContext(sandbox, { timeout: 1000 });
  assert.equal(tabs.length, 1, 'client must register exactly one right-sidebar tab');
  assert.equal(tabs[0].id, EXPECTED_NAME);
  assert.equal(tabs[0].kind, 'prompt-enhancer');
  assert.equal(typeof tabs[0].title, 'function');
  assert.equal(slots.length, 1, 'client must register one tab-body slot');
  assert.equal(slots[0].slot.name, 'sidebar.right.pane.tab');
  assert.equal(slots[0].slot.key, EXPECTED_NAME);
  assert.equal(typeof slots[0].component, 'function');
  assert.ok(dictionaries.length > 0, 'client must register locale dictionaries');
  for (const dispose of disposers.reverse()) dispose();
  return { tabId: tabs[0].id, slotKey: slots[0].slot.key, styleCount: documentNodes.length };
}

export async function assertEntryContract(entry) {
  assert.equal(entry.name, EXPECTED_NAME);
  assert.equal(typeof entry.apply, 'function');
  assert.ok(Array.isArray(entry.inject));
  assert.ok(entry.inject.includes('connection'));
  assert.equal(entry.Config?.['~standard']?.version, 1, 'Config must implement Standard Schema v1');
  assert.equal(typeof entry.Config['~standard'].validate, 'function');
  assert.ok(entry.Config['~standard'].validate({}).value, 'Config validation must return a value');
  for (const key of ['enhancePrompt', 'detectGaps', 'normalizeText', 'containsSensitiveData', 'normalizeConfig']) {
    assert.equal(typeof entry[key], 'function', `${key} is not a usable entry export`);
  }
  const result = await entry.enhancePrompt('帮我写一个报告');
  assert.equal(typeof result.enhancedPrompt, 'string');
  assert.ok(result.enhancedPrompt.includes('帮我写一个报告'), 'entry enhancement loses original input');
}

export async function assertHttpContract(entry) {
  const registrations = [];
  const disposers = [];
  let disposeCount = 0;
  const state = entry.apply({
    effect(effect) { disposers.push(effect()); },
    connection: { fetch: { register(route) { registrations.push(route); return () => { disposeCount += 1; }; } } },
  }, { locale: 'zh' });
  assert.equal(state.http, true, 'apply did not activate mocked HTTP registration');
  assert.deepEqual(registrations.map((route) => route.path).sort(), [entry.ENHANCE_PATH, entry.CONFIG_PATH].sort());
  assert.equal(entry.ENHANCE_PATH, '/api/prompt-enhancer/enhance');
  assert.equal(entry.CONFIG_PATH, '/api/prompt-enhancer/config');
  for (const route of registrations) {
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
  const request = (path, method = 'GET', body) => ({
    url: `http://localhost${path}`, method,
    ...(body === undefined ? {} : { json: async () => body }),
  });
  const enhance = registrations.find(({ path }) => path === entry.ENHANCE_PATH);
  const config = registrations.find(({ path }) => path === entry.CONFIG_PATH);
  const response = await enhance.fetch(request(entry.ENHANCE_PATH, 'POST', { prompt: '帮我写一个报告' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(result.enhancedPrompt.includes('帮我写一个报告'));
  for (const key of ['changeSet', 'assumptions', 'missingQuestions', 'riskFlags']) assert.ok(Array.isArray(result[key]), `HTTP ${key} must be an array`);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  const initial = await config.fetch(request(entry.CONFIG_PATH));
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).config.locale, 'zh');
  const update = await config.fetch(request(entry.CONFIG_PATH, 'POST', { config: { locale: 'en' } }));
  assert.equal(update.status, 200);
  assert.equal((await update.json()).config.locale, 'en');
  const after = await config.fetch(request(entry.CONFIG_PATH));
  assert.equal((await after.json()).config.locale, 'en');
  const invalid = await enhance.fetch({ url: `http://localhost${entry.ENHANCE_PATH}`, method: 'POST', body: '{invalid' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).ok, false);
  assert.equal((await enhance.fetch(request(entry.ENHANCE_PATH))).status, 405);
  for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
  assert.equal(disposeCount, 2, 'HTTP routes must be disposed with the host effect');
  assert.equal(entry.apply({}).http, false, 'headless apply must remain usable');
}

export async function runChecks(directory = root) {
  const checks = [];
  const problems = [];
  const read = (file) => readFileSync(join(directory, file), 'utf8');
  const exists = (file) => existsSync(join(directory, file));
  async function check(label, body) {
    try { await body(); checks.push(`ok   ${label}`); }
    catch (error) { problems.push(`FAIL ${label}: ${error?.message ?? error}`); }
  }
  let pkg;
  await check('package manifest exists and names the bundle', () => {
    pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.name, EXPECTED_NAME);
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, 'index.js');
  });
  await check('manifest declares the DSH patch and browser client', () => {
    assert.equal(pkg?.dsh?.bundle?.patch, './cordis.patch.yml');
    assert.equal(pkg?.dsh?.client?.platform, 'web');
    assert.equal(pkg?.dsh?.client?.immediately, true);
    assert.ok(pkg?.dsh?.client?.inject?.includes(SIDEBAR_PROVIDER), 'client manifest must inject the right-sidebar provider');
  });
  await check('package.files explicitly covers all required distribution artifacts', () => {
    const required = requiredPackageFiles(directory);
    for (const file of required) assert.ok(exists(file) && statSync(join(directory, file)).isFile(), `${file} missing`);
    assertPackageCoverage(pkg, required);
  });
  await check('patch registers exactly one matching bundle id/name', () => assertPatchContract(read('cordis.patch.yml')));
  await check('public exports resolve to the distributed entry/client/locales/icon', () => {
    assert.equal(pkg?.exports?.['.'], './index.js');
    assert.equal(pkg?.exports?.['./client'], './client.js');
    assert.equal(pkg?.exports?.['./locale/*.json'], './locale/*.json');
    assert.equal(pkg?.exports?.['./icon'], './icon.svg');
    assert.equal(pkg?.exports?.['./package.json'], './package.json');
  });
  await check('all host source imports are built-ins or covered local files', () => {
    const files = ['index.js', ...requiredPackageFiles(directory).filter((file) => file.startsWith('src/') && file.endsWith('.mjs'))];
    const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
    for (const file of files) {
      const body = read(file);
      const specifiers = [...body.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('node:')) { assert.ok(builtins.has(specifier.slice(5)), `${file} imports unknown built-in ${specifier}`); continue; }
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports external dependency ${specifier}`);
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        assert.ok(!target.startsWith('../') && exists(target), `${file} imports missing/outside file ${specifier}`);
        assert.ok(isFileCovered(target, pkg.files), `${target} is imported but not covered by package.files`);
      }
    }
  });
  await check('runtime dependencies are empty', () => {
    assert.deepEqual(pkg?.dependencies ?? {}, {});
    assert.deepEqual(pkg?.optionalDependencies ?? {}, {});
  });
  let entry;
  await check('published entry imports and exposes usable enhancement/Config exports', async () => {
    entry = await import(pathToFileURL(join(directory, 'index.js')).href);
    await assertEntryContract(entry);
  });
  await check('entry apply serves mocked enhance/config HTTP paths and disposes them', async () => {
    assert.ok(entry, 'entry import failed');
    await assertHttpContract(entry);
  });
  await check('all host modules import without extra dependencies', async () => {
    for (const file of requiredPackageFiles(directory).filter((file) => file.endsWith('.mjs'))) {
      await import(pathToFileURL(join(directory, file)).href);
    }
  });
  await check('client syntax, ModuleLoader factory and right-sidebar registration', () => inspectClient(read('client.js'), join(directory, 'client.js')));
  await check('locales and detail documentation are valid nonempty resources', () => {
    for (const locale of ['zh', 'en']) {
      const dictionary = JSON.parse(read(`locale/${locale}.json`));
      assert.ok(dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary));
      assert.ok(Object.keys(dictionary).length > 0);
    }
    assert.ok(read('docs/DETAIL.md').trim().length > 0, 'docs/DETAIL.md is empty');
  });
  await check('local icon exists and contains no active/remote content', () => {
    assert.ok(exists('icon.svg'), 'icon.svg missing');
    assert.ok(statSync(join(directory, 'icon.svg')).size <= 256 * 1024);
    const icon = read('icon.svg');
    assert.match(icon, /<svg[\s>]/i);
    assert.doesNotMatch(icon, /<script|javascript:|\bon\w+\s*=|(?:href|src)\s*=\s*['"]\s*(?:https?:|\/\/)|url\(\s*['"]?\s*(?:https?:|\/\/)/i);
  });
  return { checks, problems };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await runChecks();
  for (const line of result.checks) console.log(line);
  for (const line of result.problems) console.error(line);
  if (result.problems.length) process.exitCode = 1;
  else console.log(`\n${result.checks.length} checks passed (mocked host/browser; installation not tested)`);
}
