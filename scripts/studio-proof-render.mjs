import {bundle} from '@remotion/bundler';
import {
  getVideoMetadata,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync} from 'node:fs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  defaultProofProps,
  editedProofProps,
  mergeProofProps,
  proofComposition,
} from '../packages/studio-runtime/src/proof-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'artifacts', 'studio-proof');
const reportPath = path.join(outputDirectory, 'render-report.json');
const propsArgument = process.argv.indexOf('--props');
if (propsArgument !== -1 && !process.argv[propsArgument + 1]) {
  throw new Error('Usage: node scripts/studio-proof-render.mjs [--props path/to/input.json]');
}
const propsPath = propsArgument === -1
  ? process.env.STUDIO_PROOF_PROPS
  : process.argv[propsArgument + 1];
const editedProps = propsPath
  ? mergeProofProps(JSON.parse(await readFile(path.resolve(root, propsPath), 'utf8')))
  : mergeProofProps(editedProofProps);
const baselineProps = mergeProofProps(defaultProofProps);
const browserExecutable = process.env.CHROME_EXECUTABLE || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!browserExecutable) {
  throw new Error('Set CHROME_EXECUTABLE to an installed Chrome or Edge executable.');
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// The proof uses the same /studio-proof asset URLs in Vite and in the renderer.
const serveProofBundle = async (bundleDirectory) => {
  const assetDirectory = path.join(root, 'public');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      let filename;
      for (const directory of [assetDirectory, bundleDirectory]) {
        const candidate = path.resolve(directory, relative);
        const relation = path.relative(directory, candidate);
        if (relation.startsWith('..') || path.isAbsolute(relation)) continue;
        const details = await stat(candidate).catch(() => null);
        if (details?.isFile()) {
          filename = candidate;
          break;
        }
      }
      if (!filename) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filename)] ?? 'application/octet-stream',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      const stream = createReadStream(filename);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(400);
      response.end('Invalid asset URL');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {server, serveUrl: `http://127.0.0.1:${address.port}`};
};

await mkdir(outputDirectory, {recursive: true});
const report = {
  status: 'rendering',
  startedAt: new Date().toISOString(),
  runtime: 'Remotion 4.0.532',
  composition: proofComposition,
  stillFrame: 45,
  browserExecutable,
  sourcePropsFile: propsPath ? path.resolve(root, propsPath) : null,
  baselineProps,
  editedProps,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
let browser;
let server;
try {
  const sourceFiles = [
    'packages/studio-runtime/src/proof-model.mjs',
    'packages/studio-runtime/src/VyvydProof.tsx',
    'packages/studio-runtime/src/remotion-entry.tsx',
  ];
  const sourceHash = createHash('sha256');
  for (const filename of sourceFiles) {
    sourceHash.update(filename);
    sourceHash.update(await readFile(path.join(root, filename)));
  }
  report.sourceHash = sourceHash.digest('hex');
  console.log('Bundling the shared vyvyd Remotion scene');
  const bundleDirectory = await bundle({
    entryPoint: path.join(root, 'packages', 'studio-runtime', 'src', 'remotion-entry.tsx'),
    rootDir: root,
    publicDir: path.join(root, 'public'),
    outDir: path.join(outputDirectory, 'bundle'),
  });
  const served = await serveProofBundle(bundleDirectory);
  server = served.server;
  browser = await openBrowser('chrome', {browserExecutable});
  const common = {serveUrl: served.serveUrl, browserExecutable, puppeteerInstance: browser};
  const outputs = {
    baseline: path.join(outputDirectory, 'baseline-frame-45.png'),
    edited: path.join(outputDirectory, 'edited-frame-45.png'),
    video: path.join(outputDirectory, 'edited.mp4'),
  };
  const compositions = new Map();
  for (const [variant, inputProps] of [['baseline', baselineProps], ['edited', editedProps]]) {
    // selectComposition() resolves composition.props. Reusing the baseline result
    // would preserve baseline props even when a later render gets new inputProps.
    const composition = await selectComposition({
      ...common, id: proofComposition.id, inputProps,
    });
    compositions.set(variant, composition);
    await renderStill({
      ...common, composition, inputProps, frame: 45,
      imageFormat: 'png', output: outputs[variant],
    });
    console.log(`Rendered ${variant} PNG at frame 45`);
  }
  await renderMedia({
    ...common,
    composition: compositions.get('edited'),
    inputProps: editedProps,
    outputLocation: outputs.video,
    codec: 'h264',
    crf: 18,
    pixelFormat: 'yuv420p',
    imageFormat: 'png',
    concurrency: 2,
  });
  report.videoMetadata = await getVideoMetadata(outputs.video);
  if (report.videoMetadata.width !== proofComposition.width
    || report.videoMetadata.height !== proofComposition.height
    || report.videoMetadata.fps !== proofComposition.fps
    || Math.abs(report.videoMetadata.durationInSeconds
      - proofComposition.durationInFrames / proofComposition.fps) > 0.01) {
    throw new Error('Rendered video metadata does not match the shared composition.');
  }
  report.outputs = await Promise.all(Object.entries(outputs).map(async ([variant, filename]) => ({
    variant,
    path: path.relative(root, filename).replaceAll('\\', '/'),
    bytes: (await stat(filename)).size,
    sha256: createHash('sha256').update(await readFile(filename)).digest('hex'),
  })));
  report.stillsDiffer = report.outputs[0].sha256 !== report.outputs[1].sha256;
  if (!propsPath && !report.stillsDiffer) {
    throw new Error('The default edited props did not change the rendered still.');
  }
  await writeFile(path.join(outputDirectory, 'edited-props.json'), JSON.stringify(editedProps, null, 2) + '\n');
  report.status = 'complete';
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  if (browser) await browser.close({silent: true});
  if (server) await new Promise((resolve) => server.close(resolve));
}
