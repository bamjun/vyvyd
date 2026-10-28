import assert from 'node:assert/strict';
import {Blob, File} from 'node:buffer';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Exercise the real tools' recovery callbacks and event guards; IndexedDB and
// byte/URL round trips are covered by the workspace store's own tests.
const mountTool = (name, ready = true) => {
  const slots = [];
  const effects = [];
  const receivers = new Map();
  const revoked = [];
  const objects = new Map();
  const cache = new Map();
  let cursor = 0;
  let tree;
  let workspace;
  let nextUrl = 0;
  const state = {ready, saving: false, error: '', restored: false, updatedAt: null, clearSaved: async () => {}};
  const react = {
    createElement(type, props, ...children) {
      if (type === 'canvas' && props?.ref) props.ref.current = {};
      return {type, props: {...props, children}};
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {current: initial};
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !deps || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) {
        effects.push(effect);
        slots[index] = {deps};
      }
    },
    useMemo(create, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) slots[index] = {deps, value: create()};
      return slots[index].value;
    },
  };
  class Image {
    naturalWidth = 100;
    naturalHeight = 60;
    set src(value) {
      this.file = objects.get(value);
      queueMicrotask(() => this.onload());
    }
  }
  const stubs = {
    react: {...react, default: react},
    'lucide-react': new Proxy({}, {get: (_, key) => `icon:${String(key)}`}),
    'canvas-confetti': {default() {}},
    '@/lib/utils': {formatBytes: (value) => String(value)},
    '@/hooks/useMediaWorkspace': {useMediaWorkspace(options) {workspace = options; return state;}},
    '@/hooks/useDiscordWebhookSender': {useDiscordWebhookSender: () => ({activeRequestId: null, status: null, send: async () => {}})},
    '@/hooks/useMediaTransfer': {
      useMediaReceiver: (target, receive) => receivers.set(target, receive),
      useMediaTransfer: () => ({notice: null, busy: false}),
    },
    '@/lib/gifProcessing': {processGifFilters() {throw new Error('Unexpected conversion');}, mergeGifFiles() {throw new Error('Unexpected conversion');}},
    '@/lib/convertVideo': {convertVideoToGif() {throw new Error('Unexpected conversion');}},
  };
  for (const component of ['MediaWorkspaceNotice', 'DownloadZipButton', 'DiscordSendStatus', 'ResultActions', 'TargetSizeControl',
    'SettingsPresets', 'ImageBatchStatus', 'CancelProcessingButton', 'VideoOutputSettings', 'VideoOutputPreview', 'CropOverlay', 'CropPresetControls']) {
    stubs[`./${component}`] = {[component]: component};
  }
  const paths = {
    '@/lib/cancellation': '../src/lib/cancellation.ts', './cancellation': '../src/lib/cancellation.ts',
    '@/lib/imageBatch': '../src/lib/imageBatch.ts', '@/lib/videoBatch': '../src/lib/videoBatch.ts',
    '@/lib/imageSplitter': '../src/lib/imageSplitter.ts', '@/lib/targetSize': '../src/lib/targetSize.ts', './targetSize': '../src/lib/targetSize.ts',
    '@/lib/imagePadding': '../src/lib/imagePadding.ts', '@/lib/mediaMerger': '../src/lib/mediaMerger.ts',
    '@/lib/cropPresets': '../src/lib/cropPresets.ts', '@/lib/videoGeometry': '../src/lib/videoGeometry.ts', './videoGeometry': '../src/lib/videoGeometry.ts',
    '@/lib/videoSettings': '../src/lib/videoSettings.ts', '@/lib/settingsPresets': '../src/lib/settingsPresets.ts',
    '@/hooks/useProcessingTask': '../src/hooks/useProcessingTask.ts',
  };
  const load = (path) => {
    if (cache.has(path)) return cache.get(path);
    const api = {};
    cache.set(path, api);
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React},
    }).outputText;
    runInNewContext(source, {
      exports: api, Error, Blob, File, AbortController, DOMException, queueMicrotask, setTimeout, clearTimeout, console,
      window: {Image}, document: {createElement() {throw new Error('Unexpected decoder');}},
      URL: {createObjectURL(blob) {const url = `blob:new-${++nextUrl}`; objects.set(url, blob); return url;}, revokeObjectURL: (url) => revoked.push(url)},
      require(dependency) {
        if (dependency in stubs) return stubs[dependency];
        if (dependency in paths) return load(paths[dependency]);
        throw new Error(`Unexpected dependency: ${dependency}`);
      },
    });
    return api;
  };
  const Tool = load(`../src/components/${name}.tsx`)[name];
  const render = () => {
    cursor = 0;
    tree = Tool({onSuccess() {throw new Error('Recovery must not count as a new export');}, discordWebhookUrl: '', isActive: true});
    effects.splice(0).forEach((effect) => effect());
  };
  const nodes = (predicate) => {
    const result = [];
    const visit = (entry) => {
      if (Array.isArray(entry)) {entry.forEach(visit); return;}
      if (!entry || typeof entry !== 'object') return;
      if (predicate(entry)) result.push(entry);
      visit(entry.props?.children);
    };
    visit(tree);
    return result;
  };
  render();
  return {
    state, render, nodes, revoked, receivers,
    snapshot: () => workspace.snapshot,
    restore(snapshot) {workspace.restore(snapshot); render();},
    reset(handler = 'reset') {
      const button = nodes((entry) => entry.type === 'button' && entry.props.onClick?.name === handler)[0];
      assert.ok(button);
      button.props.onClick(); render();
    },
  };
};

const file = () => new File([new Uint8Array([1, 2, 3])], '복원.png', {type: 'image/png', lastModified: 123});
const plain = (value) => JSON.parse(JSON.stringify(value));

test('restored image batches retain exact completed downloads and avoid ID collisions on later transfers', async (t) => {
  for (const [name, tool, inputsKey, prefix, urlKey] of [
    ['ImageResizer', 'resize', 'imageItems', 'resize-input-', 'src'],
    ['ImageSplitter', 'split', 'images', 'split-input-', 'url'],
  ]) {
    await t.test(name, async () => {
      const host = mountTool(name);
      const input = {id: `${prefix}19`, file: file(), [urlKey]: 'blob:restored-input', width: 100, height: 60};
      const output = name === 'ImageResizer'
        ? {id: input.id, originalName: '복원.png', downloadName: '복원_50x30.png', url: 'blob:restored-result', size: 10, originalSize: 3, width: 50, height: 30}
        : {id: `${input.id}-0-0`, sourceId: input.id, sourceName: '복원.png', fileName: '복원_row-1_col-1.png', url: 'blob:restored-result', size: 10, width: 50, height: 60, column: 0, row: 0};
      const snapshot = {...host.snapshot(), [inputsKey]: [input], results: [output], fileStates: {[input.id]: {status: 'succeeded'}}};
      host.restore(snapshot);
      const savedDownload = host.nodes((entry) => entry.type === 'a' && entry.props.download)[0];
      assert.equal(savedDownload.props.href, 'blob:restored-result');
      assert.equal(host.snapshot()[inputsKey][0].file, input.file);
      await host.receivers.get(tool)([new File(['next'], 'next.png', {type: 'image/png'})]);
      host.render();
      assert.deepEqual(Array.from(host.snapshot()[inputsKey], (item) => item.id), [`${prefix}19`, `${prefix}20`]);
      assert.equal(host.snapshot().results[0].url, 'blob:restored-result');
      assert.deepEqual(host.revoked, []);
      host.reset();
      assert.ok(host.revoked.includes('blob:restored-input'));
      assert.ok(host.revoked.includes('blob:restored-result'));
      assert.equal(host.snapshot()[inputsKey].length, 0);
      assert.equal(host.snapshot().results.length, 0);
    });
  }
});

test('video recovery restores selected source, per-file trim/crop, common settings and completed GIF without rendering', () => {
  const host = mountTool('VideoToGif');
  const source = {id: 'video-restored', file: new File(['mp4'], '영상.mp4', {type: 'video/mp4'}), src: 'blob:restored-video', width: 1920, height: 1080, duration: 8,
    settings: {crop: {x: 10, y: 20, width: 800, height: 600}, cropPreset: 'free', startTime: 2, endTime: 6, outputWidth: '400', outputHeight: '300', aspectLocked: true, fitMode: 'contain', scale: 0.5}};
  const saved = {...host.snapshot(), videoItems: [source], selectedVideoId: source.id, showCrop: false, fps: 7, dither: 'none', targetEnabled: true, targetValue: '800', targetUnit: 'KB',
    defaultOutputPreset: {width: '400', height: '300', aspectLocked: true, fitMode: 'contain'},
    results: [{id: source.id, fileName: source.file.name, url: 'blob:restored-gif', size: 10, width: 400, height: 300}], fileStates: {[source.id]: {status: 'succeeded'}}};
  host.restore(saved);
  assert.deepEqual(plain(host.snapshot()), plain(saved));
  assert.equal(host.nodes((entry) => entry.type === 'video' && entry.props.controls)[0].props.src, 'blob:restored-video');
  assert.equal(host.nodes((entry) => entry.type === 'a' && entry.props.download)[0].props.href, 'blob:restored-gif');
  assert.equal(host.snapshot().videoItems[0].file, source.file);
  host.reset();
  assert.ok(host.revoked.includes('blob:restored-video'));
  assert.ok(host.revoked.includes('blob:restored-gif'));
});

test('uploads and transfers cannot overwrite snapshots while initial recovery is pending', async (t) => {
  for (const [name, tool] of [['ImageResizer', 'resize'], ['ImageSplitter', 'split'], ['VideoToGif', 'video'], ['ImagePadding', 'padding'], ['ImageCropper', 'crop'], ['MediaMerger', 'merge']]) {
    await t.test(name, async () => {
      const host = mountTool(name, false);
      const before = plain(host.snapshot());
      const input = host.nodes((entry) => entry.type === 'input' && entry.props.type === 'file')[0];
      assert.equal(input.props.disabled, true);
      const selected = {files: [file()], value: 'chosen'};
      await input.props.onChange({target: selected, currentTarget: selected});
      if (host.receivers.has(tool)) await assert.rejects(host.receivers.get(tool)([file()]));
      host.render();
      assert.deepEqual(plain(host.snapshot()), before);
    });
  }
});

test('padding recovery restores placement, background and original downloads and owns their cleanup', () => {
  const host = mountTool('ImagePadding');
  const input = {id: 'padding-restored', file: file(), src: 'blob:restored-padding-input', width: 100, height: 60, outputHeight: 178};
  const saved = {...host.snapshot(), imageItems: [input], background: 'white', alignment: 'bottom',
    results: [{id: input.id, fileName: input.file.name, outputName: '9x16_복원.png', url: 'blob:restored-padding-output', size: 10, width: 100, height: 178}], fileStates: {[input.id]: {status: 'succeeded'}}};
  host.restore(saved);
  assert.deepEqual(plain(host.snapshot()), plain(saved));
  assert.equal(host.nodes((entry) => entry.type === 'a' && entry.props.download)[0].props.href, 'blob:restored-padding-output');
  host.reset();
  assert.ok(host.revoked.includes('blob:restored-padding-input'));
  assert.ok(host.revoked.includes('blob:restored-padding-output'));
});

test('crop recovery keeps exact crop preset, scale and output; edits are blocked until ready', () => {
  const host = mountTool('ImageCropper');
  const saved = {...host.snapshot(), sourceFile: file(), sourceUrl: 'blob:restored-crop-input', sourceWidth: 100, sourceHeight: 60,
    crop: {x: 15, y: 10, width: 32, height: 40}, cropPreset: '4:5', scale: 0.5,
    result: {url: 'blob:restored-crop-output', fileName: 'cropped_복원_16x20.png', size: 10, width: 16, height: 20}};
  host.restore(saved);
  assert.deepEqual(plain(host.snapshot()), plain(saved));
  assert.equal(host.nodes((entry) => entry.type === 'a' && entry.props.download)[0].props.href, 'blob:restored-crop-output');
  host.state.ready = false;
  host.render();
  host.reset('clearSource');
  assert.deepEqual(plain(host.snapshot()), plain(saved));
  assert.deepEqual(host.revoked, []);
  host.state.ready = true;
  host.render();
  host.reset('clearSource');
  assert.ok(host.revoked.includes('blob:restored-crop-input'));
  assert.ok(host.revoked.includes('blob:restored-crop-output'));
  assert.equal(host.snapshot().sourceFile, null);
  assert.equal(host.snapshot().result, null);
});

test('merge recovery preserves order and output and advances new source IDs past restored output IDs', async () => {
  const host = mountTool('MediaMerger');
  const png = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'next.png', {type: 'image/png'});
  const saved = {...host.snapshot(), mode: 'image', direction: 'vertical', fit: 'match', alignment: 'end',
    sources: [{id: 'source-19', file: png(), url: 'blob:merge-input-19', width: 100, height: 60}, {id: 'source-20', file: png(), url: 'blob:merge-input-20', width: 100, height: 60}],
    result: {id: 'result-23', fileName: 'merged-vertical.png', url: 'blob:merge-output-23', size: 10, width: 100, height: 120}};
  host.restore(saved);
  assert.deepEqual(plain(host.snapshot()), plain(saved));
  assert.equal(host.nodes((entry) => entry.type === 'a' && entry.props.download)[0].props.href, 'blob:merge-output-23');
  await host.receivers.get('merge')([png()]);
  host.render();
  assert.deepEqual(Array.from(host.snapshot().sources, (source) => source.id), ['source-19', 'source-20', 'source-24']);
  assert.equal(host.snapshot().result.url, 'blob:merge-output-23');
  host.reset();
  assert.ok(host.revoked.includes('blob:merge-input-19'));
  assert.ok(host.revoked.includes('blob:merge-input-20'));
  assert.ok(host.revoked.includes('blob:merge-output-23'));
});

test('ZIP creation blocks source resets until the archive has finished reading completed result URLs', async (t) => {
  for (const name of ['ImageResizer', 'ImageSplitter', 'ImagePadding', 'VideoToGif']) {
    await t.test(name, () => {
      const host = mountTool(name);
      const source = {id: 'restored-zip-source', file: file(), src: 'blob:zip-source', url: 'blob:zip-source', width: 100, height: 60, outputHeight: 178, duration: 5,
        settings: {crop: {x: 0, y: 0, width: 100, height: 60}, cropPreset: 'free', startTime: 0, endTime: 4, outputWidth: '50', outputHeight: '30', aspectLocked: true, fitMode: 'contain', scale: 0.5}};
      const output = {id: source.id, sourceId: source.id, fileName: 'restored.png', originalName: 'restored.png', downloadName: 'restored_50x30.png', outputName: '9x16_restored.png',
        url: 'blob:zip-result', size: 10, originalSize: 3, width: 50, height: 30, column: 0, row: 0};
      const inputsKey = name === 'VideoToGif' ? 'videoItems' : name === 'ImageSplitter' ? 'images' : 'imageItems';
      const saved = {...host.snapshot(), [inputsKey]: [source], results: [output], fileStates: {[source.id]: {status: 'succeeded'}}};
      host.restore(saved);
      const zip = host.nodes((entry) => entry.type === 'DownloadZipButton')[0];
      assert.ok(zip);
      assert.equal(zip.props.assets[0].url, output.url);
      zip.props.onBusyChange(true);
      host.render();
      host.reset();
      assert.equal(host.snapshot()[inputsKey].length, 1);
      assert.equal(host.snapshot().results[0].url, output.url);
      assert.deepEqual(host.revoked, []);
      zip.props.onBusyChange(false);
      host.render();
      host.reset();
      assert.equal(host.snapshot()[inputsKey].length, 0);
      assert.ok(host.revoked.includes(output.url));
    });
  }
});
