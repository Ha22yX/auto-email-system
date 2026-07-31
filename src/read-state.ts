export function buildOptimisticPanelReadPatch(panelRead: boolean, now = new Date().toISOString()) {
  return {
    panelRead,
    panelReadAt: panelRead ? now : undefined
  };
}
