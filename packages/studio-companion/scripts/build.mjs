import {copyFile, mkdir, readdir, realpath, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(packageRoot, 'dist');
const companionOutput = path.join(output, 'studio-companion', 'src');
const runtimeOutput = path.join(output, 'studio-runtime', 'src');
const runtimeSource = path.resolve(packageRoot, '..', 'studio-runtime', 'src');
const sharedFiles = ['project-model.mjs', 'export-model.mjs', 'dom-layer-geometry.mjs'];

// Only the package's own generated dist directory may be replaced.
if (path.dirname(output) !== path.resolve(packageRoot) || path.basename(output) !== 'dist') {
  throw new Error('Invalid package output directory');
}
const existing = await realpath(output).catch((cause) => {
  if (cause.code === 'ENOENT') return null;
  throw cause;
});
if (existing && path.resolve(existing) !== output) throw new Error('Package dist must not be a symbolic link');
await rm(output, {recursive: true, force: true});
await mkdir(companionOutput, {recursive: true});
await mkdir(runtimeOutput, {recursive: true});
const files = (await readdir(path.join(packageRoot, 'src'))).filter((name) => name.endsWith('.mjs'));
for (const name of files) await copyFile(path.join(packageRoot, 'src', name), path.join(companionOutput, name));
for (const name of sharedFiles) await copyFile(path.join(runtimeSource, name), path.join(runtimeOutput, name));
for (const name of ['server.mjs', 'mcp-server.mjs', 'preview-worker.mjs', 'export-worker.mjs', 'cli-main.mjs']) {
  if (!(await stat(path.join(companionOutput, name))).isFile()) throw new Error(`Missing package entry: ${name}`);
}
process.stdout.write(`Prepared ${files.length + sharedFiles.length} runtime modules for npm packaging.\n`);
