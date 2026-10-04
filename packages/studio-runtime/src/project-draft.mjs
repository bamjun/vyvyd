import {validateProjectDocument, validateProjectSettings} from './project-model.mjs';
import {parseLayerNumber, readStudioLayerRegistry, rebaseStudioLayerDraft} from './layer-editor.mjs';

const fieldNames = ['name', 'width', 'height', 'fps', 'seconds', 'backgroundColor'];
const properties = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity', 'text', 'fontSize', 'color', 'assetId', 'hidden', 'locked', 'zIndex']);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => {throw new TypeError('프로젝트 초안 형식이 올바르지 않습니다.');};
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0;

function object(value, allowed) {
  if (!plain(value) || Object.keys(value).some((key) => forbidden.has(key) || !allowed.includes(key))) fail();
  return value;
}

function fields(value) {
  const input = object(value, fieldNames);
  const output = {};
  for (const key of fieldNames) {
    const maximum = key === 'name' ? 256 : 64;
    if (!Object.hasOwn(input, key) || typeof input[key] !== 'string' || input[key].length > maximum) fail();
    output[key] = input[key];
  }
  return output;
}

function layerValue(property, value) {
  if (!properties.has(property)) return false;
  if (['hidden', 'locked'].includes(property)) return typeof value === 'boolean';
  if (['text', 'color', 'assetId'].includes(property)) {
    if (typeof value !== 'string' || value.length > (property === 'text' ? 10000 : 128)) return false;
    return property !== 'color' || /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
  }
  return typeof value === 'number' && parseLayerNumber(property, String(value)) !== null;
}

function snapshot(value, project) {
  const input = object(value, ['fields', 'layers']);
  if (!plain(input.layers) || Object.keys(input.layers).length > 200) fail();
  const definitions = project ? new Map(readStudioLayerRegistry(project).map((layer) => [layer.id, layer])) : null;
  const layers = {};
  for (const [id, values] of Object.entries(input.layers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id) || forbidden.has(id) || !plain(values)) fail();
    const definition = definitions?.get(id);
    if (definitions && !definition) fail();
    const result = {};
    for (const [property, value] of Object.entries(values)) {
      if (!layerValue(property, value) || (definition && !definition.editable.includes(property))) fail();
      if (project && property === 'assetId' && !project.assets.some((asset) => asset.id === value)) fail();
      result[property] = value;
    }
    layers[id] = result;
  }
  return {fields: fields(input.fields), layers};
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value >= 1;
const uuid = (value) => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail();
  return value.toLowerCase();
};
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
};
const equal = (left, right) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

export function studioDraftForProject(project) {
  const document = validateProjectDocument(project);
  return snapshot({
    fields: {
      name: document.name,
      width: String(document.composition.width), height: String(document.composition.height),
      fps: String(document.composition.fps), seconds: String(document.composition.durationInFrames / document.composition.fps),
      backgroundColor: document.edits.backgroundColor,
    },
    layers: document.edits.layers,
  }, document);
}

export function rebaseStudioDraft(baseSnapshot, draftSnapshot, latestDoc) {
  const base = snapshot(baseSnapshot);
  const draft = snapshot(draftSnapshot);
  const latest = studioDraftForProject(latestDoc);
  const rebased = rebaseStudioLayerDraft(base.layers, draft.layers, latest.layers, readStudioLayerRegistry(latestDoc), latestDoc.assets);
  const mergedFields = Object.fromEntries(fieldNames.map((key) => [key, draft.fields[key] !== base.fields[key] ? draft.fields[key] : latest.fields[key]]));
  return {snapshot: {fields: mergedFields, layers: rebased.layers}, discarded: rebased.discarded};
}

function projectFromSubmitted(base, submitted) {
  const field = submitted.fields;
  if (!field.width.trim() || !field.height.trim() || !field.fps.trim() || !field.seconds.trim()) fail();
  const fps = Number(field.fps);
  const settings = validateProjectSettings({name: field.name, composition: {
    id: 'Poster', width: Number(field.width), height: Number(field.height), fps,
    durationInFrames: Math.round(Number(field.seconds) * fps),
  }});
  return validateProjectDocument({...base, ...settings, edits: {backgroundColor: field.backgroundColor, layers: submitted.layers}});
}

export function parseStoredStudioDraft(value) {
  try {
    const input = object(value, ['version', 'projectId', 'base', 'snapshot', 'pending']);
    if (input.version !== 1) fail();
    const base = validateProjectDocument(input.base);
    if (uuid(input.projectId) !== base.id) fail();
    // Validate the authoritative base's layer contract as well as the local draft.
    studioDraftForProject(base);
    const draft = snapshot(input.snapshot, base);
    const output = {base, snapshot: draft};
    if (input.pending !== undefined) {
      const pending = object(input.pending, ['kind', 'requestId', 'expectedRevision', 'project', 'targetRevision', 'submitted']);
      if (!['save', 'restore'].includes(pending.kind) || !positiveInteger(pending.expectedRevision) || pending.expectedRevision !== base.revision) fail();
      const common = {kind: pending.kind, requestId: uuid(pending.requestId), expectedRevision: pending.expectedRevision, submitted: snapshot(pending.submitted, base)};
      if (pending.kind === 'save') {
        if (Object.hasOwn(pending, 'targetRevision')) fail();
        const candidate = validateProjectDocument(pending.project);
        if (candidate.id !== base.id || candidate.revision !== pending.expectedRevision || candidate.createdAt !== base.createdAt
          || candidate.updatedAt !== base.updatedAt || !equal(candidate.source, base.source) || !equal(candidate.assets, base.assets)
          || !equal(candidate, projectFromSubmitted(base, common.submitted))) fail();
        output.pending = {...common, project: candidate};
      } else {
        if (Object.hasOwn(pending, 'project') || !positiveInteger(pending.targetRevision) || pending.targetRevision > pending.expectedRevision) fail();
        output.pending = {...common, targetRevision: pending.targetRevision};
      }
    }
    return output;
  } catch {return null;}
}
