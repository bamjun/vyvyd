import {z} from 'zod';

const id = z.string().uuid().transform((value) => value.toLowerCase());
const project = {projectId: id};
const mutation = {...project, expectedRevision: z.number().int().positive(), requestId: id};
const files = z.record(z.string().max(240), z.string()).refine((value) => Object.keys(value).length <= 20, '최대 20개 파일을 한 번에 수정할 수 있습니다.');
const layerEdits = z.record(z.string().max(120), z.record(z.unknown()).nullable());
const backgroundColor = z.string().regex(/^#[0-9a-f]{6}$/i).optional();
const tool = (name, description, shape, readOnly = true) => ({name, description, shape, schema: z.object(shape).strict(), readOnly});

export const CODEX_TOOLS = [
  tool('studio_list_projects', 'List saved vyvyd Poster Maker projects with IDs and revisions. Read the target project before editing.', {}),
  tool('studio_read_project', 'Read project composition, assets, user edits, registered layers and compile state. includeSource=true includes all scoped source files.', {...project, includeSource: z.boolean().default(false)}),
  tool('studio_read_file', 'Read an exact source path listed by studio_read_project. Never reads arbitrary host files.', {...project, path: z.string().max(240)}),
  tool('studio_read_asset', 'See an image registered to this project, using its stable assetId.', {...project, assetId: id}),
  tool('studio_apply_source', 'Patch project TSX/CSS/JSON files, validate compilation and start/middle/end render, then atomically commit. Validation failure preserves previous source/preview. Keep registerRoot and the Poster composition; use input props composition, backgroundColor, layers, assets, assetUrls. Register editable layer metadata in src/layers.json. Retries must use identical requestId and contents.', {...mutation, files, deleteFiles: z.array(z.string().max(240)).max(20).default([]), backgroundColor, layerEdits: layerEdits.optional()}, false),
  tool('studio_update_edits', 'Patch registered layer edits and/or background color, validate renders, then commit. Null layer or property clears an override. Supported properties are declared in src/layers.json. Read latest revision first.', {...mutation, backgroundColor, layerEdits: layerEdits.optional()}, false),
  tool('studio_add_image', 'Add PNG/JPEG/WebP/GIF image bytes to the project. Max 20 MiB. Same requestId retry cannot create a duplicate file. Use returned asset ID in assetUrls.', {...mutation, name: z.string().min(1).max(255), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), base64: z.string().min(1).max(Math.ceil(20 * 1024 * 1024 / 3) * 4)}, false),
  tool('studio_validate_source', 'Compile and render a proposed source patch without saving or replacing the active preview. Return validation diagnostics.', {...project, expectedRevision: z.number().int().positive(), files}),
  tool('studio_get_status', 'Read current saved revision, compilation/validation result and real MCP activity.', project),
  tool('studio_preview', 'Return a PNG of the current saved project for visual inspection. Frame defaults to the middle of the composition.', {...project, frame: z.number().int().nonnegative().optional()}),
];

export const MCP_INSTRUCTIONS = `Edit the user's vyvyd Poster Maker project through these tools. First read project IDs, latest revision, source, assets and manual layer overrides. Write free Remotion design code; do not import ad-mage templates. Mutations require projectId, expectedRevision and a fresh UUID requestId; reuse it only for an identical retry. Failed validation keeps the last good project. Inspect studio_preview after applying. AI requests stay in this Codex chat; this server does not call an AI API.
Source entry is src/Root.tsx with registerRoot() and one Poster Composition. Its calculateMetadata must use props.composition dimensions, FPS and duration. Runtime props are {composition,backgroundColor,layers,assets,assetUrls}. Use assetUrls[assetId] for images. Supported imports are installed React/Remotion packages and project-scoped relative sources; do not import host files, use inline webpack loaders, fetch remote code or access parent UI. Optional src/layers.json is an array of {id,type:'text'|'image'|'shape'|'group',label,editable:[...],defaults:{...}}. Stable layer IDs let the user override x,y,width,height,rotation,scale,opacity,text,fontSize,color,assetId,hidden,locked,zIndex. The source must merge props.layers[id] over defaults and render those values itself. Preserve user overrides unless the user asks to change them. Clear removed layer overrides explicitly with layerEdits:{oldId:null}.
For direct browser editing, put one unique data-layer-id={id} marker on each registered HTML layer wrapper. Apply editable x/y as left/top in its positioned parent, and render rotation, scale, opacity, hidden and zIndex from merged values. Keep IDs stable across source edits. Reordering requires editable zIndex on all registered siblings sharing an immediate DOM parent. The preview measures the current frame's DOM bounds; SVG, 3D/perspective and singular parent transforms cannot be dragged. Locked registered ancestors prevent moving their children. Clear overrides for removed editable properties explicitly with layerEdits:{id:{property:null}} in the same source patch.`;

export function parseTool(name, args) {
  const definition = CODEX_TOOLS.find((item) => item.name === name);
  if (!definition) return null;
  return {definition, args: definition.schema.parse(args)};
}
