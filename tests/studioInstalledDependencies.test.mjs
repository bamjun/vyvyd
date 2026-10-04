import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createBrowserDependencyPolicy, createProjectBoundaryPlugin} from '../packages/studio-companion/src/browser-dependencies.mjs';

const installedBundlerRequire = createRequire(createRequire(import.meta.url).resolve('@remotion/bundler'));
const webpackResolver = installedBundlerRequire('enhanced-resolve').create.sync;

const install = async (modules, name, manifest = {}) => {
  const root = path.join(modules, name);
  await mkdir(root, {recursive: true});
  await writeFile(path.join(root, 'package.json'), JSON.stringify({name, version: '1.0.0', main: 'index.js', ...manifest}));
  await writeFile(path.join(root, 'index.js'), 'module.exports = {};');
  return root;
};

const fixture = async (t, nested) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-installed-dependencies-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vyvyd-installed-dependencies-'));
    await rm(root, {recursive: true, force: true});
  });
  const hostModules = path.join(root, 'node_modules');
  const companion = await install(hostModules, '@bamjun/vyvyd-studio');
  const modules = nested ? path.join(companion, 'node_modules') : hostModules;
  const bundlerModules = nested === 'mixed' ? hostModules : modules;
  const bundler = await install(bundlerModules, '@remotion/bundler', {main: 'dist/index.js',
    dependencies: {'style-loader': '4.0.0', 'css-loader': '7.1.4', 'remotion-internal': '1.0.0'}});
  await mkdir(path.join(bundler, 'dist', 'esbuild-loader'), {recursive: true});
  await writeFile(path.join(bundler, 'dist', 'index.js'), 'module.exports = {};');
  await writeFile(path.join(bundler, 'dist', 'esbuild-loader', 'index.js'), 'module.exports = {};');
  const loaderModules = nested ? path.join(bundler, 'node_modules') : hostModules;
  const styleLoader = await install(loaderModules, 'style-loader');
  const cssLoader = await install(loaderModules, 'css-loader');
  const remotionInternal = await install(nested === 'mixed' ? hostModules : modules, 'remotion-internal', {dependencies: {zod: '4.0.0'}});
  const zod4 = await install(path.join(remotionInternal, 'node_modules'), 'zod', {version: '4.0.0'});
  const zod3 = await install(modules, 'zod', {version: '3.23.8'});
  // Package discovery must work even when a package exposes only ESM imports.
  const react = await install(modules, 'react', {exports: {'.': {import: './index.js'}}});
  const unrelated = await install(hostModules, 'private-host-package');
  const undeclared = await install(path.join(remotionInternal, 'node_modules'), 'undeclared');
  const snapshot = path.join(root, 'preview-snapshot');
  await mkdir(snapshot);
  await writeFile(path.join(snapshot, 'entry.js'), 'export {};');
  const hostFile = path.join(root, 'host-secret.js');
  await writeFile(hostFile, 'export const secret = true;');
  const fromUrl = pathToFileURL(path.join(companion, 'dist', 'studio-companion', 'src', 'preview-runtime.mjs'));
  await mkdir(path.dirname(fileURLToPath(fromUrl)), {recursive: true});
  const policy = createBrowserDependencyPolicy({fromUrl, packages: ['@remotion/bundler', 'react', 'zod']});
  return {root, modules, policy, react, zod3, zod4, remotionInternal, styleLoader, cssLoader,
    unrelated, undeclared, snapshot, hostFile};
};

for (const nested of [false, true]) {
  test(`installed ${nested ? 'nested' : 'hoisted'} dependencies retain package-local versions and reject unrelated host paths`, async (t) => {
    const f = await fixture(t, nested);
    assert.deepEqual(f.policy.moduleDirectories, [f.modules]);
    for (const dependency of [f.react, f.zod3, f.zod4, f.styleLoader, f.cssLoader]) {
      assert.equal(f.policy.canImport(path.join(dependency, 'index.js')), true);
    }
    for (const filename of [path.join(f.unrelated, 'index.js'), path.join(f.undeclared, 'index.js'), f.hostFile]) {
      assert.equal(f.policy.canImport(filename), false);
    }
    assert.ok(f.policy.allowedLoaders.has(await realpath(path.join(f.styleLoader, 'index.js'))));
    assert.ok(f.policy.allowedLoaders.has(await realpath(path.join(f.cssLoader, 'index.js'))));
    const localRequire = createRequire(path.join(f.remotionInternal, 'index.js'));
    assert.equal(localRequire.resolve('zod'), path.join(f.zod4, 'index.js'));
    assert.notEqual(localRequire.resolve('zod'), path.join(f.zod3, 'index.js'));
    const resolve = webpackResolver({modules: ['node_modules', ...f.policy.moduleDirectories]});
    assert.equal(resolve(f.snapshot, 'zod'), path.join(f.zod3, 'index.js'));
    assert.equal(resolve(f.remotionInternal, 'zod'), path.join(f.zod4, 'index.js'));
  });
}

test('mixed dependency layouts prefer companion-local versions ahead of consumer conflicts', async (t) => {
  const f = await fixture(t, 'mixed');
  const hostModules = path.join(f.root, 'node_modules');
  const conflictingZod = await install(hostModules, 'zod', {version: '2.0.0'});
  assert.deepEqual(f.policy.moduleDirectories, [f.modules, hostModules]);
  const resolve = webpackResolver({modules: ['node_modules', ...f.policy.moduleDirectories]});
  let beforeResolve;
  createProjectBoundaryPlugin(f.snapshot, f.policy).apply({hooks: {normalModuleFactory: {
    tap(name, action) {action({hooks: {
      beforeResolve: {tap(name, callback) {beforeResolve = callback;}},
      afterResolve: {tap() {}},
    }});},
  }}});
  const projectImport = {request: 'zod', context: f.snapshot};
  beforeResolve(projectImport);
  assert.equal(resolve(projectImport.context, projectImport.request), path.join(f.zod3, 'index.js'));
  const internalImport = {request: 'zod', context: f.remotionInternal};
  beforeResolve(internalImport);
  assert.equal(internalImport.context, f.remotionInternal);
  assert.equal(resolve(f.remotionInternal, 'zod'), path.join(f.zod4, 'index.js'));
  assert.equal(f.policy.canImport(path.join(f.zod4, 'index.js')), true);
  assert.equal(f.policy.canImport(path.join(conflictingZod, 'index.js')), false);
});

test('the Webpack boundary accepts trusted CSS loaders and rejects project loaders, builtins and host imports', async (t) => {
  const f = await fixture(t, true);
  let beforeResolve; let afterResolve;
  const factory = {hooks: {
    beforeResolve: {tap(name, action) {beforeResolve = action;}},
    afterResolve: {tap(name, action) {afterResolve = action;}},
  }};
  createProjectBoundaryPlugin(f.snapshot, f.policy).apply({hooks: {normalModuleFactory: {
    tap(name, action) {action(factory);},
  }}});
  const entry = path.join(f.snapshot, 'entry.js');
  for (const loader of f.policy.allowedLoaders) {
    assert.doesNotThrow(() => beforeResolve({request: `-!${loader}?trusted=true!${entry}`, context: f.snapshot}));
  }
  assert.doesNotThrow(() => beforeResolve({request: `!!${entry}`, context: f.snapshot}));
  for (const request of [`${f.hostFile}!${entry}`, `not-installed-loader!${entry}`]) {
    assert.throws(() => beforeResolve({request, context: f.snapshot}), /Project-defined Webpack loaders/);
  }
  for (const request of ['node:fs', 'fs/promises', 'path']) {
    assert.throws(() => beforeResolve({request, context: f.snapshot}), /Node.js host modules/);
  }
  for (const resource of [entry, path.join(f.zod3, 'index.js'), path.join(f.zod4, 'index.js')]) {
    assert.doesNotThrow(() => afterResolve({createData: {resource: `${resource}?query=true`}}));
  }
  for (const resource of [f.hostFile, path.join(f.unrelated, 'index.js'), path.join(f.undeclared, 'index.js')]) {
    assert.throws(() => afterResolve({createData: {resource}}), /Imports must stay inside/);
  }
});

test('an installed dependency cannot authorize a symlink to an unrelated host file', async (t) => {
  const f = await fixture(t, true);
  const link = path.join(f.react, 'escape.js');
  try {await symlink(f.hostFile, link, 'file');} catch (error) {
    if (error.code === 'EPERM') {t.skip('File symlinks require Windows developer mode or permission.'); return;}
    throw error;
  }
  assert.equal(f.policy.canImport(link), false);
});
