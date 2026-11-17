import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  assertEntryContract,
  assertHttpContract,
  assertPackageCoverage,
  assertPatchContract,
  inspectClient,
  isFileCovered,
  requiredPackageFiles,
  runChecks,
} from '../tools/check-plugin-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-prompt-enhancer-pack-'));
  // The absolute, mkdtemp-created path is checked before recursive cleanup.
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(directory.startsWith(join(resolve(tmpdir()), 'dsh-prompt-enhancer-pack-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function packageManager() {
  const nodeDirectory = dirname(process.execPath);
  const candidates = [
    ['npm', process.env.DSH_NPM_CLI],
    ['npm', process.env.npm_execpath?.includes('npm-cli') ? process.env.npm_execpath : null],
    ['npm', resolve(nodeDirectory, '../node_modules/npm/bin/npm-cli.js')],
    ['npm', resolve(nodeDirectory, 'node_modules/npm/bin/npm-cli.js')],
    ['pnpm', process.env.DSH_PNPM_CLI],
    ['pnpm', process.env.npm_execpath?.includes('pnpm') ? process.env.npm_execpath : null],
    // Bundled dependency layout returned by load_workspace_dependencies:
    // dependencies/node/bin/node.exe + dependencies/pnpm/bin/pnpm.mjs.
    ['pnpm', resolve(nodeDirectory, '../../pnpm/bin/pnpm.mjs')],
  ];
  const match = candidates.find(([, file]) => file && existsSync(file));
  return match ? { name: match[0], cli: match[1] } : null;
}

function readTarString(header, start, length) {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

/** Minimal read-only POSIX tar reader; no third-party tar/extraction dependency. */
function readTarball(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = parseInt(readTarString(header, 148, 8).trim(), 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(checksum, expectedChecksum, 'tar header checksum mismatch');
    const size = parseInt(readTarString(header, 124, 12).trim() || '0', 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'invalid tar member size');
    const prefix = readTarString(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${readTarString(header, 0, 100)}`;
    const type = readTarString(header, 156, 1);
    const start = offset + 512;
    assert.ok(start + size <= tar.length, `truncated tar member: ${name}`);
    if (type === '' || type === '0') {
      assert.ok(name.startsWith('package/'), `unexpected tar member prefix: ${name}`);
      const file = name.slice('package/'.length);
      assert.ok(file && !isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'), `unsafe tar member: ${name}`);
      assert.ok(!files.has(file), `duplicate tar member: ${name}`);
      files.set(file, tar.subarray(start, start + size));
    } else {
      // npm/pnpm may emit harmless PAX metadata; no links/devices may be extracted.
      assert.ok(['5', 'x', 'g'].includes(type), `unsupported/unsafe tar member type ${type}: ${name}`);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('package.files covers all runtime, documentation, patch, locale and icon artifacts', () => {
  assertPackageCoverage(manifest(), requiredPackageFiles(root));
});

test('files coverage distinguishes src directories/globs from misleading prefix matches', () => {
  assert.equal(isFileCovered('src/plugin.mjs', ['src']), true);
  assert.equal(isFileCovered('src/plugin.mjs', ['src/*.mjs']), true);
  assert.equal(isFileCovered('src/deep/helper.mjs', ['src/**/*.mjs']), true);
  assert.equal(isFileCovered('src/plugin.mjs', ['src/**/*.mjs']), true);
  assert.equal(isFileCovered('src/plugin.mjs', ['src/plugin.mjs.map']), false);
  assert.equal(isFileCovered('docs/DETAIL.md', ['docs-old']), false);
  assert.equal(isFileCovered('src/plugin.mjs', ['src', '!src/plugin.mjs']), false);
  assert.throws(() => isFileCovered('index.js', ['../index.js']), /unsafe/);
});

test('missing required files entries are rejected even when source files exist', () => {
  for (const file of requiredPackageFiles(root)) {
    const otherFiles = requiredPackageFiles(root).filter((entry) => entry !== file);
    assert.throws(() => assertPackageCoverage({ files: otherFiles }, [file]), /does not cover/);
  }
});

test('patch checker accepts quoted YAML ids and rejects duplicate or prefixed ids', () => {
  assert.doesNotThrow(() => assertPatchContract("- insert:\n    - id: 'dsh-prompt-enhancer'\n      name: \"dsh-prompt-enhancer\"\n      config: {}\n"));
  assert.throws(() => assertPatchContract('- insert:\n    - id: dsh-prompt-enhancer-extra\n      name: dsh-prompt-enhancer\n'));
  assert.throws(() => assertPatchContract('- insert:\n    - id: dsh-prompt-enhancer\n      name: dsh-prompt-enhancer\n    - id: another-plugin\n      name: another-plugin\n'));
});

test('client ModuleLoader and sidebar checks execute current artifact and reject broken artifacts', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  assert.deepEqual(inspectClient(source), {
    tabId: 'dsh-prompt-enhancer', slotKey: 'dsh-prompt-enhancer', styleCount: 1,
  });
  assert.throws(() => inspectClient(`${source}\nfunction (`), /Unexpected|SyntaxError/);
  assert.throws(() => inspectClient('void 0'), /ModuleLoader.load/);
  assert.throws(() => inspectClient("window.__ModuleLoader__.load({id:'wrong',factory(){return {}}})"), /wrong|dsh-prompt-enhancer/);
  assert.throws(() => inspectClient("window.__ModuleLoader__.load({id:'dsh-prompt-enhancer',factory(){return {inject:[],apply(){}}}})"), /inject omits/);
  const noTab = "window.__ModuleLoader__.load({id:'dsh-prompt-enhancer',factory(){return {inject:['locale','slots','sidebarRightTabs'],apply(){}}}})";
  assert.throws(() => inspectClient(noTab), /right-sidebar tab/);
});

test('all source-distribution contract checks pass without installing the plugin', async () => {
  const result = await runChecks(root);
  assert.deepEqual(result.problems, [], result.problems.join('\n'));
  assert.ok(result.checks.length >= 13);
});

test('real package-manager pack includes artifacts and extracted entry/HTTP contract works', async (t) => {
  const manager = packageManager();
  if (!manager) {
    t.skip('npm/pnpm CLI not found beside Node; set DSH_NPM_CLI or DSH_PNPM_CLI. No tar simulation was performed.');
    return;
  }
  const directory = temporaryDirectory(t);
  const output = join(directory, 'archives');
  mkdirSync(output);
  const args = [manager.cli, 'pack', '--json', '--pack-destination', output];
  if (manager.name === 'npm') args.push('--ignore-scripts');
  t.diagnostic(`REAL ${manager.name} pack (not a simulation): ${process.execPath} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
      npm_config_offline: 'true',
      PNPM_IGNORE_SCRIPTS: 'true',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${manager.name} pack failed\n${result.stdout}\n${result.stderr}`);
  const archives = readdirSync(output).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'real pack must create exactly one .tgz');
  const files = readTarball(readFileSync(join(output, archives[0])));
  for (const file of ['package.json', ...requiredPackageFiles(root)]) {
    assert.ok(files.has(file), `${manager.name} tarball omits ${file}`);
  }
  const packedManifest = JSON.parse(files.get('package.json').toString('utf8'));
  assert.equal(packedManifest.name, manifest().name);
  assert.equal(packedManifest.version, manifest().version);
  const extracted = join(directory, 'extracted');
  mkdirSync(extracted);
  for (const [file, bytes] of files) {
    const destination = resolve(extracted, file);
    const child = relative(extracted, destination);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`), `unsafe extraction path: ${file}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const entry = await import(pathToFileURL(join(extracted, 'index.js')).href);
  await assertEntryContract(entry);
  await assertHttpContract(entry);
  const checks = await runChecks(extracted);
  assert.deepEqual(checks.problems, [], checks.problems.join('\n'));
  t.diagnostic(`${archives[0]}: ${files.size} regular files, ${requiredPackageFiles(root).length} required artifacts present; extracted entry/enhance/mocked HTTP/client checks passed. DSH profile installation was NOT tested.`);
});
