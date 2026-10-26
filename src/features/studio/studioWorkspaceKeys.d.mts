export function studioWorkspaceKeys(workspaceKey?: string): {
  selectedKey: string;
  frameKey: string;
  draftKey: (id: string) => string;
  backupKey: (id: string) => string;
  exportKey: (id: string) => string;
};
