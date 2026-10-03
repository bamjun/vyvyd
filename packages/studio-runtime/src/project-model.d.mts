export type ProjectComposition = {
  id: 'Poster';
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
};

export type ProjectSettings = {
  name: string;
  composition: ProjectComposition;
};

export type ProjectPreviewProps = {
  backgroundColor: string;
  composition: ProjectComposition;
};

export type ProjectSettingsInput = {
  name: string;
  composition: Omit<ProjectComposition, 'id'> & {id?: 'Poster'};
};

export type ProjectAsset = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  createdAt: string;
};

export type ProjectDocument = ProjectSettings & {
  schemaVersion: 1;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: {entryPoint: 'src/Root.tsx'; files: Record<string, string>};
  assets: ProjectAsset[];
  edits: {backgroundColor: string; layers: Record<string, unknown>};
};

export const PROJECT_SCHEMA_VERSION: 1;
export const MAX_SOURCE_FILES: 20;
export const MAX_SOURCE_BYTES: number;
export function validateProjectSettings(input: unknown): ProjectSettings;
export function validateProjectDocument(input: unknown): ProjectDocument;
export function createProjectDocument(
  settings: ProjectSettingsInput,
  options?: {id?: string; now?: string | Date},
): ProjectDocument;
