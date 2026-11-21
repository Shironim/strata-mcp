export function buildNotIndexedResponse(workspaceRoot: string, isJson: boolean) {
  const notIndexedPayload = {
    status: 'NOT_INDEXED',
    workspace_root: workspaceRoot,
    suggested_action: {
      cli: 'strata init',
    },
    message: "Workspace has not been indexed by Strata yet. Run 'strata init' in the workspace root first.",
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: isJson
          ? JSON.stringify(notIndexedPayload, null, 2)
          : `[strata NOT_INDEXED] ${notIndexedPayload.message}`,
      },
    ],
  };
}
