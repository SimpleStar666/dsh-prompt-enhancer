/**
 * Distribution contract check for dsh-prompt-enhancer.
 *
 * Run with: node tools/check-plugin-contract.mjs
 * The checker uses only Node built-ins so it can run before installation.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedName = 'dsh-prompt-enhancer';
const checks = [];
const problems = [];

async function check(label, body) {
  try {
    await body();
    checks.push(`ok   ${label}`);
  } catch (error) {
    problems.push(`FAIL ${label}: ${error?.message ?? error}`);
  }
}

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const exists = (relative) => existsSync(join(root, relative));

await check('package manifest exists and names the bundle', () => {
  assert.ok(exists('package.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, expectedName);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'index.js');
});

let pkg;
if (exists('package.json')) {
  try { pkg = JSON.parse(read('package.json')); } catch { pkg = null; }
}

await check('manifest declares the DSH patch and browser client', () => {
  assert.ok(pkg, 'package.json is not valid JSON');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.immediately, true);
});

await check('patch registers exactly the prompt enhancer bundle id/name', () => {
  assert.ok(exists('cordis.patch.yml'), 'cordis.patch.yml missing');
  const patch = read('cordis.patch.yml');
  assert.match(patch, /-\s*insert:/);
  assert.match(patch, new RegExp(`(?:name|id):\\s*['"]?${expectedName}['"]?`));
  assert.match(patch, new RegExp(`id:\\s*${expectedName}`));
});

await check('runtime entry point and exports exist', () => {
  assert.ok(exists('index.js'), 'index.js missing');
  assert.ok(pkg, 'package.json is not valid JSON');
  if (pkg.exports) {
    assert.equal(pkg.exports['.'], './index.js');
  }
  for (const file of ['src/enhancer.mjs', 'src/schema.mjs', 'src/plugin.mjs']) {
    assert.ok(exists(file), `${file} missing`);
  }
});

await check('host source imports only Node built-ins or local modules', () => {
  const files = ['index.js', 'src/enhancer.mjs', 'src/schema.mjs', 'src/plugin.mjs'];
  for (const file of files) {
    const body = read(file);
    for (const match of body.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:'), `${file} imports ${specifier}`);
    }
    for (const match of body.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:'), `${file} imports ${specifier}`);
    }
  }
});

await check('runtime dependencies are empty', () => {
  assert.ok(pkg, 'package.json is not valid JSON');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.optionalDependencies ?? {}, {});
});

await check('plugin exports the required contract shape', async () => {
  const module = await import(pathToFileURL(join(root, 'index.js')).href);
  assert.equal(module.name, expectedName);
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject));
  assert.ok(module.Config && typeof module.Config === 'object');
  assert.ok(typeof module.enhancePrompt === 'function', 'enhancePrompt is not re-exported');
  assert.ok(typeof module.detectGaps === 'function', 'detectGaps is not re-exported');
  assert.ok(typeof module.normalizeText === 'function', 'normalizeText is not re-exported');
  assert.ok(typeof module.containsSensitiveData === 'function', 'containsSensitiveData is not re-exported');
});

await check('plugin contract modules are syntactically valid', async () => {
  for (const file of ['src/enhancer.mjs', 'src/schema.mjs', 'src/plugin.mjs']) {
    await import(pathToFileURL(join(root, file)).href);
  }
});

await check('no oversized or remote icon/client artifacts are required', () => {
  if (!exists('icon.svg')) return;
  assert.ok(statSync(join(root, 'icon.svg')).size <= 256 * 1024);
  assert.match(read('icon.svg'), /<svg[\s>]/i);
  assert.doesNotMatch(read('icon.svg'), /<script|javascript:/i);
});

for (const line of checks) console.log(line);
if (problems.length) {
  for (const line of problems) console.error(line);
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length} checks passed`);
}
