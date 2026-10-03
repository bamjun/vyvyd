import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectDocument,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  validateProjectDocument,
  validateProjectSettings,
} from '../packages/studio-runtime/src/project-model.mjs';

const id = 'fe47b9d5-7701-4a23-bf90-e8b4f9f33408';
const assetId = '94cf8b3a-c487-4abc-a5da-497534d57443';
const now = '2026-10-02T03:00:00.000Z';
const settings = {name: '새 홍보물', composition: {width: 960, height: 540, fps: 30, durationInFrames: 90}};
const project = () => createProjectDocument(settings, {id, now});

test('new project is a portable blank document with matching Remotion settings', () => {
  const document = project();
  assert.equal(document.id, id);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.revision, 1);
  assert.equal(document.createdAt, now);
  assert.equal(document.updatedAt, now);
  assert.deepEqual(document.assets, []);
  assert.deepEqual(document.edits, {backgroundColor: '#ffffff', layers: {}});
  assert.deepEqual(Object.keys(document.source.files), ['src/Root.tsx']);
  const entry = document.source.files[document.source.entryPoint];
  for (const setting of ['width={960}', 'height={540}', 'fps={30}', 'durationInFrames={90}']) {
    assert.ok(entry.includes(setting));
  }
  assert.ok(entry.includes('registerRoot(RemotionRoot)'));
  assert.ok(entry.includes("backgroundColor: '#ffffff'"));
  assert.ok(entry.includes('defaultProps={defaultProps}'));
  assert.ok(entry.includes('calculateMetadata={({props})'));
  for (const field of ['width', 'height', 'fps', 'durationInFrames']) {
    assert.ok(entry.includes(`${field}: props.composition.${field}`));
  }
  assert.ok(!entry.includes('<Img') && !entry.includes('<h1') && !entry.includes('<span'));
  assert.deepEqual(validateProjectDocument(JSON.parse(JSON.stringify(document))), document);
});

test('project settings accept inclusive limits and normalize the display name and composition ID', () => {
  assert.deepEqual(validateProjectSettings({
    name: '  캔버스  ', composition: {width: 64, height: 8192, fps: 1, durationInFrames: 18000},
  }), {name: '캔버스', composition: {id: 'Poster', width: 64, height: 8192, fps: 1, durationInFrames: 18000}});
  assert.doesNotThrow(() => validateProjectSettings({
    name: '🎨'.repeat(80), composition: {id: 'Poster', width: 8192, height: 64, fps: 60, durationInFrames: 1},
  }));
  for (const [field, value] of [
    ['width', 63], ['width', 8193], ['width', 960.5], ['height', 0], ['height', 8193],
    ['fps', 0], ['fps', 61], ['fps', Number.NaN], ['durationInFrames', 0], ['durationInFrames', 18001],
  ]) {
    assert.throws(() => validateProjectSettings({
      ...settings, composition: {...settings.composition, [field]: value},
    }), RangeError);
  }
  for (const name of ['', '  ', '가'.repeat(81), '제목\n다음줄']) {
    assert.throws(() => validateProjectSettings({...settings, name}));
  }
  assert.throws(() => validateProjectSettings({...settings, composition: {...settings.composition, id: 'Other'}}));
});

test('document identity, version, timestamps and complete settings are required', () => {
  for (const patch of [
    {id: '../project'}, {schemaVersion: 2}, {schemaVersion: '1'}, {revision: 0}, {revision: 1.5},
    {createdAt: '2026-02-30T03:00:00.000Z'}, {updatedAt: '2026-10-02'},
    {updatedAt: '2026-10-01T03:00:00.000Z'},
    {composition: {...settings.composition}},
  ]) assert.throws(() => validateProjectDocument({...project(), ...patch}));
  assert.throws(() => validateProjectDocument({...project(), unexpected: true}));
  assert.equal(createProjectDocument(settings, {id: id.toUpperCase(), now: new Date(now)}).id, id);
  assert.match(createProjectDocument(settings).id, /^[0-9a-f-]{36}$/);
});

test('source paths cannot escape src or alias protected files on Windows', () => {
  for (const filename of [
    '../project.json', 'project.json', 'assets/file.tsx', '/src/file.tsx',
    'C:/src/file.tsx', 'src\\file.tsx', 'src/../file.tsx', 'src/./file.tsx',
    'src//file.tsx', 'src/file.tsx/', 'src/CON.tsx', 'src/com1/file.tsx',
    'src/LPT¹.css', 'src/CON .tsx', 'src/CONIN$.tsx', 'src/file.tsx.', 'src/file.tsx ',
    'src/%2e%2e/file.tsx', 'src/file:stream.tsx', 'src/file\0.tsx', `src/${'a'.repeat(240)}.tsx`,
  ]) {
    const document = project();
    document.source.files[filename] = 'text';
    assert.throws(() => validateProjectDocument(document), undefined, filename);
  }
  const duplicate = project();
  duplicate.source.files['src/root.tsx'] = 'text';
  assert.throws(() => validateProjectDocument(duplicate), /ignoring case/);
  const directoryCollision = project();
  directoryCollision.source.files['src/root.TSX/child.ts'] = 'text';
  assert.throws(() => validateProjectDocument(directoryCollision), /must not collide/);
  const missing = project();
  missing.source.files = {'src/other.tsx': 'text'};
  assert.throws(() => validateProjectDocument(missing), /entry point is missing/);
  assert.throws(() => validateProjectDocument({...project(), source: {entryPoint: 'src/other.tsx', files: {}}}));
});

test('source limits count files and actual UTF-8 bytes across all source files', () => {
  const maximum = project();
  maximum.source.files['src/Root.tsx'] = 'a'.repeat(MAX_SOURCE_BYTES);
  assert.doesNotThrow(() => validateProjectDocument(maximum));
  maximum.source.files['src/extra.ts'] = 'a';
  assert.throws(() => validateProjectDocument(maximum), /UTF-8 bytes/);
  const unicode = project();
  unicode.source.files['src/Root.tsx'] = '가'.repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1);
  assert.throws(() => validateProjectDocument(unicode), /UTF-8 bytes/);
  const count = project();
  for (let index = 1; index < MAX_SOURCE_FILES; index += 1) count.source.files[`src/helper${index}.ts`] = '';
  assert.doesNotThrow(() => validateProjectDocument(count));
  count.source.files['src/extra.ts'] = '';
  assert.throws(() => validateProjectDocument(count), /1 to 20 files/);
  assert.throws(() => validateProjectDocument({...project(), source: {entryPoint: 'src/Root.tsx', files: {'src/Root.tsx': 3}}}));
});

test('asset metadata preserves a stable path tied to a unique asset ID', () => {
  const asset = {id: assetId, name: '로고.png', mimeType: 'image/png', size: 1234,
    relativePath: `assets/${assetId}.png`, createdAt: now};
  const document = project();
  document.assets = [asset];
  assert.deepEqual(validateProjectDocument(document).assets, [asset]);
  for (const patch of [
    {id: 'wrong'}, {size: 0}, {size: 1.5}, {size: Number.POSITIVE_INFINITY},
    {mimeType: 'image/png; charset=utf-8'}, {relativePath: '../image.png'},
    {relativePath: `assets/${id}.png`}, {relativePath: `assets/${assetId}.png.exe`},
    {createdAt: 'invalid'}, {name: ''},
  ]) assert.throws(() => validateProjectDocument({...document, assets: [{...asset, ...patch}]}));
  assert.throws(() => validateProjectDocument({...document, assets: [asset, {...asset, id: assetId.toUpperCase()}]}), /unique/);
  assert.throws(() => validateProjectDocument({...document, assets: new Array(1)}));
});

test('edits are cloned JSON values and cannot silently lose invalid data', () => {
  const document = project();
  document.edits.layers = {title: {x: 120, text: '유지할 문구', visible: true, keyframes: [null, 1]}};
  const validated = validateProjectDocument(document);
  validated.edits.layers.title.x = 200;
  assert.equal(document.edits.layers.title.x, 120);
  for (const value of [undefined, () => {}, Number.NaN, Number.POSITIVE_INFINITY, new Date(now), 1n]) {
    assert.throws(() => validateProjectDocument({...document, edits: {...document.edits, layers: {title: value}}}));
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => validateProjectDocument({...document, edits: {...document.edits, layers: {title: cyclic}}}), /cycles/);
  const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateProjectDocument({...document, edits: {...document.edits, layers: prototypeKey}}));
  assert.throws(() => validateProjectDocument({...document, edits: {...document.edits,
    layers: {title: {[Symbol('unsupported')]: 'invisible'}}}}));
  assert.throws(() => validateProjectDocument({...document, edits: {...document.edits, backgroundColor: 'white'}}));
});
