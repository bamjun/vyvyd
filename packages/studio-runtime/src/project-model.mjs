export const PROJECT_SCHEMA_VERSION = 1;
export const MAX_SOURCE_FILES = 20;
export const MAX_SOURCE_BYTES = 1024 * 1024;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

const object = (value, label, allowedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(`${label} must use string JSON keys.`);
  }
  if (allowedKeys) {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) throw new TypeError(`${label}.${key} is not supported.`);
    }
  }
  return value;
};

const integer = (value, label, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
};

const name = (value, label, maximum) => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const result = value.trim();
  if (!result || Array.from(result).length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new RangeError(`${label} must contain 1 to ${maximum} printable characters.`);
  }
  return result;
};

const uuid = (value, label) => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
};

const timestamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
};

const composition = (value, allowMissingId) => {
  const input = object(value, 'composition', ['id', 'width', 'height', 'fps', 'durationInFrames']);
  if (input.id !== 'Poster' && !(allowMissingId && input.id === undefined)) {
    throw new TypeError('composition.id must be Poster.');
  }
  return {
    id: 'Poster',
    width: integer(input.width, 'composition.width', 64, 8192),
    height: integer(input.height, 'composition.height', 64, 8192),
    fps: integer(input.fps, 'composition.fps', 1, 60),
    durationInFrames: integer(input.durationInFrames, 'composition.durationInFrames', 1, 18000),
  };
};

const sourcePath = (value) => {
  if (typeof value !== 'string' || !value.startsWith('src/') || value.length > 240
    || /[\\<>:"|?*%\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Source files must use safe relative paths inside src/.');
  }
  const segments = value.split('/');
  for (const segment of segments) {
    const base = segment.split('.')[0].trimEnd();
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base)) {
      throw new TypeError(`Unsafe source path: ${value}`);
    }
  }
  return value;
};

const source = (value) => {
  const input = object(value, 'source', ['entryPoint', 'files']);
  if (input.entryPoint !== 'src/Root.tsx') throw new TypeError('source.entryPoint must be src/Root.tsx.');
  const files = object(input.files, 'source.files');
  const entries = Object.entries(files);
  if (entries.length < 1 || entries.length > MAX_SOURCE_FILES) {
    throw new RangeError(`source.files must contain 1 to ${MAX_SOURCE_FILES} files.`);
  }
  if (!Object.hasOwn(files, input.entryPoint)) throw new TypeError('The source entry point is missing.');
  const seenPaths = new Set();
  let bytes = 0;
  for (const [filename, contents] of entries) {
    sourcePath(filename);
    const foldedPath = filename.toUpperCase().toLowerCase();
    if (seenPaths.has(foldedPath)) throw new TypeError('Source paths must be unique ignoring case.');
    seenPaths.add(foldedPath);
    if (typeof contents !== 'string') throw new TypeError(`Source file ${filename} must contain text.`);
    bytes += encoder.encode(contents).byteLength;
    if (bytes > MAX_SOURCE_BYTES) throw new RangeError(`Source files exceed ${MAX_SOURCE_BYTES} UTF-8 bytes.`);
  }
  for (const filename of seenPaths) {
    const segments = filename.split('/');
    for (let index = 2; index < segments.length; index += 1) {
      if (seenPaths.has(segments.slice(0, index).join('/'))) {
        throw new TypeError('Source file and directory paths must not collide.');
      }
    }
  }
  return {entryPoint: input.entryPoint, files: Object.fromEntries(entries)};
};

const asset = (value) => {
  const input = object(value, 'asset', ['id', 'name', 'mimeType', 'size', 'relativePath', 'createdAt']);
  const id = uuid(input.id, 'asset.id');
  if (typeof input.mimeType !== 'string'
    || input.mimeType.length > 127
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(input.mimeType)) {
    throw new TypeError('asset.mimeType must be a media type without parameters.');
  }
  if (typeof input.relativePath !== 'string') throw new TypeError('asset.relativePath must be a string.');
  const match = /^assets\/([0-9a-f-]{36})\.([a-z0-9]{1,12})$/i.exec(input.relativePath);
  if (!match || match[1].toLowerCase() !== id) {
    throw new TypeError('asset.relativePath must be assets/<its UUID>.<extension>.');
  }
  return {
    id,
    name: name(input.name, 'asset.name', 255),
    mimeType: input.mimeType.toLowerCase(),
    size: integer(input.size, 'asset.size', 1, Number.MAX_SAFE_INTEGER),
    relativePath: input.relativePath,
    createdAt: timestamp(input.createdAt, 'asset.createdAt'),
  };
};

const jsonValue = (value, label, ancestors = new Set(), depth = 0) => {
  if (depth > 32) throw new RangeError(`${label} exceeds the supported JSON nesting depth.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || !value) throw new TypeError(`${label} must contain JSON values.`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles.`);
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(jsonValue(value[index], `${label}[${index}]`, ancestors, depth + 1));
    }
  } else {
    object(value, label);
    result = Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (forbiddenKeys.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
      return [key, jsonValue(item, `${label}.${key}`, ancestors, depth + 1)];
    }));
  }
  ancestors.delete(value);
  return result;
};

const edits = (value) => {
  const input = object(value, 'edits', ['backgroundColor', 'layers']);
  if (typeof input.backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.backgroundColor)) {
    throw new TypeError('edits.backgroundColor must be a six-digit hex color.');
  }
  const layers = object(input.layers, 'edits.layers');
  for (const id of Object.keys(layers)) {
    if (!id || id.length > 120 || /[\u0000-\u001f\u007f]/.test(id) || forbiddenKeys.has(id)) {
      throw new TypeError('Layer IDs must be safe nonempty strings of at most 120 characters.');
    }
  }
  return {
    backgroundColor: input.backgroundColor.toLowerCase(),
    layers: jsonValue(layers, 'edits.layers'),
  };
};

export const validateProjectSettings = (value) => {
  const input = object(value, 'settings', ['name', 'composition']);
  return {name: name(input.name, 'name', 80), composition: composition(input.composition, true)};
};

export const validateProjectDocument = (value) => {
  const input = object(value, 'project', [
    'schemaVersion', 'id', 'name', 'revision', 'createdAt', 'updatedAt',
    'composition', 'source', 'assets', 'edits',
  ]);
  if (input.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new TypeError('Unsupported project schema version.');
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const updatedAt = timestamp(input.updatedAt, 'updatedAt');
  if (updatedAt < createdAt) throw new RangeError('updatedAt must not precede createdAt.');
  if (!Array.isArray(input.assets)) throw new TypeError('assets must be an array.');
  const assets = Array.from(input.assets, asset);
  if (new Set(assets.map((item) => item.id)).size !== assets.length) {
    throw new TypeError('Asset IDs must be unique.');
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: uuid(input.id, 'id'),
    name: name(input.name, 'name', 80),
    revision: integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    createdAt,
    updatedAt,
    composition: composition(input.composition, false),
    source: source(input.source),
    assets,
    edits: edits(input.edits),
  };
};

const blankSource = (settings) => `import {Composition, registerRoot} from 'remotion';

type ProjectComposition = {
  id: 'Poster';
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};
type PosterProps = {backgroundColor: string; composition: ProjectComposition};

const defaultProps: PosterProps = {
  backgroundColor: '#ffffff',
  composition: {id: 'Poster', width: ${settings.width}, height: ${settings.height}, fps: ${settings.fps}, durationInFrames: ${settings.durationInFrames}},
};

const Poster = ({backgroundColor}: PosterProps) => (
  <div style={{position: 'absolute', inset: 0, width: '100%', height: '100%', backgroundColor}} />
);

const RemotionRoot = () => (
  <Composition
    id="Poster"
    component={Poster}
    width={${settings.width}}
    height={${settings.height}}
    fps={${settings.fps}}
    durationInFrames={${settings.durationInFrames}}
    defaultProps={defaultProps}
    calculateMetadata={({props}) => ({
      width: props.composition.width,
      height: props.composition.height,
      fps: props.composition.fps,
      durationInFrames: props.composition.durationInFrames,
      props,
    })}
  />
);

registerRoot(RemotionRoot);
`;

export const createProjectDocument = (settings, options = {}) => {
  const validated = validateProjectSettings(settings);
  object(options, 'options', ['id', 'now']);
  const now = options.now ?? new Date();
  const iso = now instanceof Date ? now.toISOString() : timestamp(now, 'options.now');
  return validateProjectDocument({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: options.id ?? globalThis.crypto.randomUUID(),
    name: validated.name,
    revision: 1,
    createdAt: iso,
    updatedAt: iso,
    composition: validated.composition,
    source: {entryPoint: 'src/Root.tsx', files: {'src/Root.tsx': blankSource(validated.composition)}},
    assets: [],
    edits: {backgroundColor: '#ffffff', layers: {}},
  });
};
