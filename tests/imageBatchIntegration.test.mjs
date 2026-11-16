import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Execute the real component handlers and hooks. The small host supplies only
// browser I/O and React's state/ref lifecycle, so failures enter production code.
const mountTool = (name, { encode, beforeObjectUrl } = {}) => {
  const slots = [];
  const effects = [];
  const moduleCache = new Map();
  const objects = new Map();
  const created = [];
  const revoked = [];
  const encodes = [];
  const successes = [];
  const receivers = new Map();
  const pendingBatches = new Set();
  const allocationAttempts = new Map();
  let cursor = 0;
  let tree;
  let objectSequence = 0;
  let currentImage;

  const context = {
    clearRect() {}, fillRect() {},
    drawImage(image) { currentImage = image; },
  };
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    toBlob(callback, type = 'image/png', quality) {
      const source = currentImage.file.name;
      const attempt = encodes.filter((entry) => entry.source === source).length + 1;
      const call = { source, attempt, type, quality, width: canvas.width, height: canvas.height };
      encodes.push(call);
      const result = encode ? encode(call) : undefined;
      Promise.resolve(result).then((blob) => callback(blob === undefined
        ? new Blob([new Uint8Array(100)], { type }) : blob));
    },
  };
  const fakeUrl = {
    createObjectURL(blob) {
      const source = blob instanceof File ? blob.name : currentImage.file.name;
      if (!(blob instanceof File)) {
        const attempt = (allocationAttempts.get(source) ?? 0) + 1;
        allocationAttempts.set(source, attempt);
        beforeObjectUrl?.({ source, attempt, blob });
      }
      const url = `blob:integration-${++objectSequence}`;
      objects.set(url, blob);
      created.push({ url, blob, source });
      return url;
    },
    revokeObjectURL(url) { revoked.push(url); objects.delete(url); },
  };
  class Image {
    naturalWidth = 100;
    naturalHeight = 60;
    set src(url) {
      this.file = objects.get(url);
      queueMicrotask(() => this.onload());
    }
  }
  const react = {
    createElement(type, props, ...children) {
      if (type === 'canvas' && props?.ref) props.ref.current = canvas;
      return { type, props: { ...props, children } };
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) {
        effects.push(effect);
        slots[index] = { deps };
      }
    },
  };
  const stubs = {
    react: { ...react, default: react },
    'lucide-react': new Proxy({}, { get: (_, key) => `icon:${String(key)}` }),
    'canvas-confetti': { default() {} },
    '@/lib/utils': { formatBytes: (value) => `${value} B` },
    './DiscordSendStatus': { DiscordSendStatus: 'DiscordSendStatus' },
    './ResultActions': { ResultActions: 'ResultActions' },
    './TargetSizeControl': { TargetSizeControl: 'TargetSizeControl' },
    './SettingsPresets': { SettingsPresets: 'SettingsPresets' },
    './MediaWorkspaceNotice': { MediaWorkspaceNotice: 'MediaWorkspaceNotice' },
    './DownloadZipButton': { DownloadZipButton: 'DownloadZipButton' },
    '@/hooks/useMediaWorkspace': { useMediaWorkspace: () => ({ ready: true, saving: false, error: '', restored: false, updatedAt: null, clearSaved: async () => {} }) },
    './ImageBatchStatus': { ImageBatchStatus: 'ImageBatchStatus' },
    './CancelProcessingButton': { CancelProcessingButton: 'CancelProcessingButton' },
    '@/hooks/useDiscordWebhookSender': {
      useDiscordWebhookSender: () => ({ activeRequestId: null, status: null, send: async () => {} }),
    },
    '@/hooks/useMediaTransfer': {
      useMediaReceiver: (target, receiver) => receivers.set(target, receiver),
      useMediaTransfer: () => ({ busy: false }),
    },
    '@/lib/gifProcessing': { processGifFilters: () => { throw new Error('Unexpected GIF processing'); } },
  };
  const realPaths = {
    '@/lib/cancellation': '../src/lib/cancellation.ts',
    './cancellation': '../src/lib/cancellation.ts',
    '@/lib/imageBatch': '../src/lib/imageBatch.ts',
    '@/lib/imageSplitter': '../src/lib/imageSplitter.ts',
    '@/lib/imagePadding': '../src/lib/imagePadding.ts',
    '@/lib/targetSize': '../src/lib/targetSize.ts',
    '@/hooks/useProcessingTask': '../src/hooks/useProcessingTask.ts',
  };
  const load = (path) => {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const api = {};
    moduleCache.set(path, api);
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    }).outputText;
    runInNewContext(source, {
      exports: api, Error, DOMException, AbortController, Blob, File,
      URL: fakeUrl, window: { Image }, console, queueMicrotask,
      require(dependency) {
        if (dependency in stubs) return stubs[dependency];
        if (!(dependency in realPaths)) throw new Error(`Unexpected dependency: ${dependency}`);
        const loaded = load(realPaths[dependency]);
        if (dependency !== '@/lib/imageBatch') return loaded;
        return {
          ...loaded,
          runImageBatch(options) {
            const pending = loaded.runImageBatch(options);
            pendingBatches.add(pending);
            pending.finally(() => pendingBatches.delete(pending)).catch(() => {});
            return pending;
          },
        };
      },
    });
    return api;
  };
  const Tool = load(`../src/components/${name}.tsx`)[name];
  const render = () => {
    cursor = 0;
    tree = Tool({ onSuccess: (size) => successes.push(size), discordWebhookUrl: '' });
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  const nodes = (predicate) => {
    const matches = [];
    const visit = (entry) => {
      if (Array.isArray(entry)) { entry.forEach(visit); return; }
      if (!entry || typeof entry !== 'object') return;
      if (predicate(entry)) matches.push(entry);
      visit(entry.props?.children);
    };
    visit(tree);
    return matches;
  };
  const text = (entry) => {
    if (Array.isArray(entry)) return entry.map(text).join('');
    if (entry && typeof entry === 'object') return text(entry.props?.children);
    return entry === null || entry === undefined || entry === false ? '' : String(entry);
  };
  const find = (predicate) => {
    const found = nodes(predicate)[0];
    assert.ok(found, `Element not found in ${name}: ${predicate}`);
    return found;
  };
  const component = (type) => find((entry) => entry.type === type);
  const button = (pattern) => find((entry) => entry.type === 'button' && pattern.test(text(entry)));
  const downloads = () => nodes((entry) => entry.type === 'a' && entry.props.download)
    .map(({ props }) => ({ name: props.download, url: props.href }));
  const settle = async () => {
    while (pendingBatches.size) await Promise.allSettled([...pendingBatches]);
    // Component finally blocks run after the batch settles.
    await new Promise((resolve) => setImmediate(resolve));
    render();
  };
  render();
  return {
    render, find, nodes, text, component, button, downloads, settle,
    encodes, successes, created, revoked, receivers,
    status: () => component('ImageBatchStatus').props,
    async upload(names) {
      const input = find((entry) => entry.type === 'input' && entry.props.type === 'file');
      await input.props.onChange({ target: {
        files: names.map((fileName) => new File([new Uint8Array(1000)], fileName, { type: 'image/png', lastModified: 1 })),
        value: 'selected',
      } });
      render();
    },
    async click(pattern) { button(pattern).props.onClick(); await settle(); },
  };
};

test('image tools continue after a failed source and retry only that source without losing completed URLs', async (t) => {
  for (const tool of ['ImageResizer', 'ImagePadding', 'ImageSplitter']) {
    await t.test(tool, async () => {
      let failed = false;
      const host = mountTool(tool, { encode: ({ source, attempt }) => {
        if (source === 'b.png' && attempt === (tool === 'ImageSplitter' ? 2 : 1) && !failed) {
          failed = true;
          return null;
        }
      } });
      await host.upload(['a.png', 'b.png', 'c.png']);
      if (tool === 'ImageSplitter') {
        host.find((entry) => entry.type === 'input' && entry.props.id === 'split-columns')
          .props.onChange({ target: { value: '2' } });
        host.render();
      }
      await host.click(tool === 'ImageResizer' ? /크기 줄이기/ : tool === 'ImagePadding' ? /이미지 만들기/ : /조각 만들기/);
      assert.deepEqual(Object.values(plain(host.status().states)).map(({ status }) => status), ['succeeded', 'failed', 'succeeded']);
      const retained = host.downloads();
      const completedCount = tool === 'ImageSplitter' ? 4 : 2;
      assert.equal(retained.length, completedCount);
      assert.ok(retained.every(({ name }) => !name.startsWith('b_') && !name.includes('b.png')));
      const beforeCalls = host.encodes.filter(({ source }) => source !== 'b.png').length;

      if (tool === 'ImageResizer') {
        const presets = host.component('SettingsPresets').props;
        presets.onApply({ ...presets.settings, percentage: 25, outputFormat: 'webp' });
      } else if (tool === 'ImagePadding') host.button(/^White$/).props.onClick();
      else host.find((entry) => entry.type === 'input' && entry.props.id === 'split-columns')
        .props.onChange({ target: { value: '3' } });
      host.render();
      assert.deepEqual(host.downloads(), retained, 'changing settings must keep already completed output');
      assert.ok(retained.every(({ url }) => !host.revoked.includes(url)));

      host.status().onRetryFailed();
      await host.settle();
      assert.deepEqual(Object.values(plain(host.status().states)).map(({ status }) => status), ['succeeded', 'succeeded', 'succeeded']);
      assert.equal(host.encodes.filter(({ source }) => source !== 'b.png').length, beforeCalls);
      const finished = host.downloads();
      assert.equal(finished.length, tool === 'ImageSplitter' ? 7 : 3);
      assert.equal(new Set(finished.map(({ url }) => url)).size, finished.length);
      assert.ok(retained.every((saved) => finished.some((entry) => entry.url === saved.url)));
      assert.equal(host.successes.length, finished.length, 'only published outputs increment completion counters');
      if (tool === 'ImageResizer') {
        const retried = finished.find(({ name }) => name.startsWith('b_'));
        assert.match(retried.name, /25x15\.webp$/);
      }

      await host.click(/전체 .*다시/);
      assert.ok(retained.every(({ url }) => host.revoked.includes(url)), 'an explicit full rerun replaces old outputs');
      assert.equal(host.downloads().length, tool === 'ImageSplitter' ? 9 : 3);
    });
  }
});

test('an individual image retry leaves other failures untouched', async () => {
  const host = mountTool('ImageResizer', { encode: ({ source, attempt }) => {
    if (source !== 'a.png' && attempt === 1) return null;
  } });
  await host.upload(['a.png', 'b.png', 'c.png']);
  await host.click(/크기 줄이기/);
  const status = host.status();
  const b = status.items.find(({ name }) => name === 'b.png');
  status.onRetry(b.id);
  await host.settle();
  assert.deepEqual(Object.values(plain(host.status().states)).map(({ status: state }) => state), ['succeeded', 'succeeded', 'failed']);
  assert.deepEqual(host.encodes.map(({ source }) => source), ['a.png', 'b.png', 'c.png', 'b.png']);
  assert.equal(host.downloads().length, 2);
});

test('output URL allocation failure is isolated and partial split allocations are revoked before retry', async (t) => {
  for (const tool of ['ImageResizer', 'ImagePadding', 'ImageSplitter']) {
    await t.test(tool, async () => {
      const host = mountTool(tool, { beforeObjectUrl: ({ source, attempt }) => {
        if (source === 'b.png' && attempt === (tool === 'ImageSplitter' ? 2 : 1)) {
          throw new Error('결과 URL을 만들 수 없습니다.');
        }
      } });
      await host.upload(['a.png', 'b.png', 'c.png']);
      if (tool === 'ImageSplitter') {
        host.find((entry) => entry.type === 'input' && entry.props.id === 'split-columns')
          .props.onChange({ target: { value: '2' } });
        host.render();
      }
      await host.click(tool === 'ImageResizer' ? /크기 줄이기/ : tool === 'ImagePadding' ? /이미지 만들기/ : /조각 만들기/);
      const state = plain(host.status().states);
      assert.deepEqual(Object.values(state).map(({ status }) => status), ['succeeded', 'failed', 'succeeded']);
      assert.equal(Object.values(state)[1].message, '결과 URL을 만들 수 없습니다.');
      const retained = host.downloads();
      assert.equal(retained.length, tool === 'ImageSplitter' ? 4 : 2);
      assert.equal(host.successes.length, retained.length);
      if (tool === 'ImageSplitter') {
        const unpublished = host.created.filter(({ blob, source }) => !(blob instanceof File) && source === 'b.png');
        assert.equal(unpublished.length, 1, 'the first part allocated a URL before the second allocation failed');
        assert.ok(unpublished.every(({ url }) => host.revoked.includes(url)), 'a failed source releases every unpublished part URL');
      }
      host.status().onRetryFailed();
      await host.settle();
      assert.deepEqual(Object.values(plain(host.status().states)).map(({ status }) => status), ['succeeded', 'succeeded', 'succeeded']);
      assert.equal(host.downloads().length, tool === 'ImageSplitter' ? 6 : 3);
      assert.ok(retained.every((saved) => host.downloads().some(({ url }) => url === saved.url)));
      assert.ok(retained.every(({ url }) => !host.revoked.includes(url)));
      assert.equal(host.successes.length, host.downloads().length);
    });
  }
});

test('adding a transferred image resumes only the new input and preserves completed resize results', async () => {
  const host = mountTool('ImageResizer');
  await host.upload(['a.png', 'b.png']);
  await host.click(/크기 줄이기/);
  const retained = host.downloads();
  await host.receivers.get('resize')([
    new File([new Uint8Array(1000)], 'transferred.png', { type: 'image/png', lastModified: 2 }),
  ]);
  host.render();
  assert.deepEqual(host.downloads(), retained);
  host.status().onResume();
  await host.settle();
  assert.deepEqual(host.encodes.map(({ source }) => source), ['a.png', 'b.png', 'transferred.png']);
  assert.equal(host.downloads().length, 3);
  assert.ok(retained.every((saved) => host.downloads().some(({ url }) => url === saved.url)));
  assert.ok(retained.every(({ url }) => !host.revoked.includes(url)));
});

test('removing one split source removes only its results and leaves the remaining inputs usable', async () => {
  const host = mountTool('ImageSplitter');
  await host.upload(['a.png', 'b.png']);
  host.find((entry) => entry.type === 'input' && entry.props.id === 'split-columns')
    .props.onChange({ target: { value: '2' } });
  host.render();
  await host.click(/조각 만들기/);
  const before = host.downloads();
  const removedParts = before.filter(({ name }) => name.startsWith('a_'));
  const retainedParts = before.filter(({ name }) => name.startsWith('b_'));
  assert.equal(removedParts.length, 2);
  assert.equal(retainedParts.length, 2);
  const removedInput = host.created.find(({ blob }) => blob instanceof File && blob.name === 'a.png');
  const retainedInput = host.created.find(({ blob }) => blob instanceof File && blob.name === 'b.png');

  await host.receivers.get('split')([
    new File([new Uint8Array(1000)], 'c.png', { type: 'image/png', lastModified: 2 }),
  ]);
  host.render();
  host.find((entry) => entry.type === 'button' && entry.props['aria-label'] === 'a.png 삭제').props.onClick();
  host.render();

  assert.deepEqual(plain(host.status().items.map(({ name }) => name)), ['b.png', 'c.png']);
  assert.deepEqual(host.downloads(), retainedParts);
  assert.ok(host.revoked.includes(removedInput.url));
  assert.ok(removedParts.every(({ url }) => host.revoked.includes(url)));
  assert.ok(!host.revoked.includes(retainedInput.url));
  assert.ok(retainedParts.every(({ url }) => !host.revoked.includes(url)));
  assert.equal(Object.keys(host.status().states).length, 1);

  await host.click(/전체 다시 처리/);
  assert.deepEqual(host.encodes.map(({ source }) => source), ['a.png', 'a.png', 'b.png', 'b.png', 'b.png', 'b.png', 'c.png', 'c.png']);
  assert.equal(host.downloads().length, 4);
  assert.ok(host.downloads().every(({ name }) => !name.startsWith('a_')));

  host.find((entry) => entry.type === 'button' && entry.props['aria-label'] === 'b.png 삭제').props.onClick();
  host.render();
  host.find((entry) => entry.type === 'button' && entry.props['aria-label'] === 'c.png 삭제').props.onClick();
  host.render();
  assert.ok(host.find((entry) => entry.type === 'input' && entry.props.type === 'file'));
  assert.deepEqual(host.downloads(), []);
});

test('split cancellation keeps completed sources and resumes partial sources without publishing duplicate parts', async () => {
  const entered = deferred();
  const release = deferred();
  let paused = false;
  const host = mountTool('ImageSplitter', { encode: ({ source, attempt, type }) => {
    if (source === 'b.png' && attempt === 2 && !paused) {
      paused = true;
      entered.resolve();
      return release.promise.then(() => new Blob([new Uint8Array(100)], { type }));
    }
  } });
  await host.upload(['a.png', 'b.png', 'c.png']);
  host.find((entry) => entry.type === 'input' && entry.props.id === 'split-columns')
    .props.onChange({ target: { value: '2' } });
  host.render();
  host.button(/조각 만들기/).props.onClick();
  await entered.promise;
  host.render();
  const retained = host.downloads();
  assert.equal(retained.length, 2);
  host.component('CancelProcessingButton').props.onClick();
  release.resolve();
  await host.settle();
  assert.deepEqual(Object.values(plain(host.status().states)).map(({ status }) => status), ['succeeded', 'cancelled', 'cancelled']);
  assert.deepEqual(host.downloads(), retained);
  assert.equal(host.created.filter(({ blob }) => !(blob instanceof File)).length, 2, 'partial source buffers never become published URLs');
  assert.equal(host.successes.length, 2);

  host.status().onResume();
  await host.settle();
  assert.equal(host.downloads().length, 6);
  assert.equal(new Set(host.downloads().map(({ name }) => name)).size, 6);
  assert.equal(host.encodes.filter(({ source }) => source === 'a.png').length, 2);
  assert.ok(retained.every((saved) => host.downloads().some(({ url }) => url === saved.url)));
  assert.ok(retained.every(({ url }) => !host.revoked.includes(url)));
  assert.equal(host.successes.length, 6);
});
