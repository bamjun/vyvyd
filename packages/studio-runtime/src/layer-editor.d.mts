import type {ProjectDocument} from './project-model.mjs';

export type StudioLayerProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'scale' | 'opacity' | 'text' | 'fontSize' | 'color' | 'assetId' | 'hidden' | 'locked' | 'zIndex';
export type StudioLayerValues = {
  x: number; y: number; width: number; height: number; rotation: number; scale: number;
  opacity: number; text: string; fontSize: number; color: string; assetId: string;
  hidden: boolean; locked: boolean; zIndex: number;
};
export type StudioLayerDefinition = {
  id: string;
  type: 'text' | 'image' | 'shape' | 'group';
  label: string;
  editable: StudioLayerProperty[];
  defaults: Partial<StudioLayerValues>;
};
export type ParentBasis = {a: number; b: number; c: number; d: number};
export type LayerGeometry = {
  id: string; x: number; y: number; width: number; height: number;
  groupId: string | null; siblingGroupId?: string; movable: boolean; locked?: boolean; parentBasis: ParentBasis;
};
export function readStudioLayerRegistry(project: ProjectDocument): StudioLayerDefinition[];
export function getEffectiveLayerValues(layer: StudioLayerDefinition, edits: Record<string, unknown>): StudioLayerValues;
export function parseLayerNumber(property: StudioLayerProperty, text: string): number | null;
export function inverseTransformDelta(parentBasis: ParentBasis, delta: {x: number; y: number}): {x: number; y: number} | null;
export function rebaseStudioLayerDraft(
  baseEdits: Record<string, unknown>, draftEdits: Record<string, unknown>, latestEdits: Record<string, unknown>,
  registry: StudioLayerDefinition[], assets: ProjectDocument['assets'],
): {layers: Record<string, unknown>; discarded: string[]};
export function getLayerReorderPatch(
  registry: StudioLayerDefinition[], edits: Record<string, unknown>, measured: LayerGeometry[],
  selectedId: string | null, direction: 'up' | 'down',
): Record<string, {zIndex: number}> | null;
/** Canvas hit targets in back-to-front order within measured sibling groups. */
export function orderLayerGeometryForHitTest(
  registry: StudioLayerDefinition[], edits: Record<string, unknown>, measured: LayerGeometry[],
): LayerGeometry[];
