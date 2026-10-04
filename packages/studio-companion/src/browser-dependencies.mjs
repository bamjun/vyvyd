import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {builtinModules, createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const browserPackages = ['@remotion/bundler', 'react', 'react-dom', 'remotion', '@remotion/player',
  '@remotion/browser-bundler', '@remotion/canvas', '@fontsource/noto-sans-kr', 'zod'];
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const inside = (directory, filename) => {
  const relative = path.relative(directory, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonical = (filename) => realpathSync(filename);

const installedPackage = (name, resolver) => {
  if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(name) || name === '.' || name === '..') return null;
  // Reading the manifest directly also works for ESM-only packages and packages
  // which do not export package.json. Only Node's own search locations are used.
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const manifestPath = path.join(directory, name, 'package.json');
    if (existsSync(manifestPath)) {
      const root = canonical(path.dirname(manifestPath));
      return {root, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), moduleDirectory: directory};
    }
  }
  return null;
};

export function createBrowserDependencyPolicy({fromUrl = import.meta.url, packages = browserPackages} = {}) {
  const resolver = createRequire(fromUrl);
  const records = new Map();
  const moduleDirectories = new Set();
  const visit = (record) => {
    if (records.has(record.root)) return;
    records.set(record.root, record);
    const localResolver = createRequire(path.join(record.root, 'package.json'));
    const dependencies = {...record.manifest.dependencies, ...record.manifest.optionalDependencies,
      ...record.manifest.peerDependencies};
    for (const name of Object.keys(dependencies)) {
      const dependency = installedPackage(name, localResolver);
      // Platform-specific optional dependencies and optional peers may be absent.
      if (dependency) visit(dependency);
    }
  };
  for (const name of packages) {
    const record = installedPackage(name, resolver);
    if (!record) throw new Error(`Required Studio browser dependency is missing: ${name}`);
    moduleDirectories.add(record.moduleDirectory);
    visit(record);
  }
  const bundlerEntry = resolver.resolve('@remotion/bundler');
  const bundlerResolver = createRequire(bundlerEntry);
  const allowedLoaders = new Set([
    bundlerResolver.resolve('style-loader'), bundlerResolver.resolve('css-loader'),
    path.join(path.dirname(bundlerEntry), 'esbuild-loader', 'index.js'),
  ].map(canonical));
  const packageRoots = [...records.keys()];
  const permittedResources = new Map();
  const canImport = (filename) => {
    if (permittedResources.has(filename)) return permittedResources.get(filename);
    let allowed = false;
    try {
      const resolved = canonical(filename);
      allowed = packageRoots.some((root) => inside(root, resolved)
        // A declared package's folder must not authorize arbitrary nested packages.
        && !path.relative(root, resolved).split(path.sep).includes('node_modules'));
    } catch { /* A missing resource cannot be an installed dependency. */ }
    permittedResources.set(filename, allowed);
    return allowed;
  };
  // A hoisted bundler must not put the consumer's node_modules ahead of browser
  // packages nested under the companion because their versions conflict.
  const orderedModules = (resolver.resolve.paths('@remotion/bundler') ?? [])
    .filter((directory) => moduleDirectories.has(directory));
  return {moduleDirectories: orderedModules, packageRoots, allowedLoaders, canImport,
    projectResolveDirectory: path.dirname(fileURLToPath(fromUrl))};
}

export const createProjectBoundaryPlugin = (snapshotDirectory, dependencies) => {
  const snapshotRoot = canonical(snapshotDirectory);
  return {
    apply(compiler) {
      compiler.hooks.normalModuleFactory.tap('VyvydProjectBoundary', (factory) => {
        factory.hooks.beforeResolve.tap('VyvydProjectBoundary', (data) => {
          if (!data) return;
          const parts = data.request.split('!');
          // "-!" and "!!" are Webpack loader-control prefixes, not loaders.
          for (const raw of parts.slice(0, -1).filter((part) => part && part !== '-')) {
            const loader = raw.split('?', 1)[0];
            const fromContext = createRequire(path.join(data.context || snapshotDirectory, '__studio_loader__.js'));
            let allowed = false;
            try {
              const resolved = path.isAbsolute(loader) ? loader : fromContext.resolve(loader);
              allowed = dependencies.allowedLoaders.has(canonical(resolved));
            } catch { /* Unknown loaders are also project-defined loaders. */ }
            if (!allowed) {
              throw new Error('Project-defined Webpack loaders are not allowed.');
            }
          }
          const request = parts.at(-1).split('?', 1)[0];
          if (request.startsWith('node:') || nodeBuiltins.has(request)) {
            throw new Error('Node.js host modules are not available inside a poster project.');
          }
          // Snapshot ancestors can contain the consumer's conflicting packages.
          // Resolve project package imports from this companion installation;
          // installed packages retain their own context and nested versions.
          if (request && !request.startsWith('.') && !path.isAbsolute(request)
            && inside(snapshotRoot, canonical(data.context || snapshotDirectory))) {
            data.context = dependencies.projectResolveDirectory;
          }
        });
        factory.hooks.afterResolve.tap('VyvydProjectBoundary', (data) => {
          const resource = data?.createData?.resource?.split('?', 1)[0];
          if (resource && !inside(snapshotRoot, canonical(resource)) && !dependencies.canImport(resource)) {
            throw new Error('Imports must stay inside this project or installed browser dependencies.');
          }
        });
      });
    },
  };
};
