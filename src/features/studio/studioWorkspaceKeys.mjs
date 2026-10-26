export function studioWorkspaceKeys(workspaceKey) {
  const prefix = workspaceKey ? `vyvyd.studio.workspace.${encodeURIComponent(workspaceKey).replace(/\./g, '%2E')}` : 'vyvyd.studio';
  return {
    selectedKey: `${prefix}.currentProject`,
    frameKey: `${prefix}.frames`,
    draftKey: (id) => `${prefix}.draft.${id}`,
    backupKey: (id) => `${prefix}.recovery.${id}`,
    exportKey: (id) => `${prefix}.export-request.${id}`,
  };
}
