import type { Goto } from '../../webview/overview-protocol';

type Navigator = (g: Goto) => Promise<void>;
let navigator: Navigator | undefined;

/** The sidebar panel registers itself here so commands in other modules can drive it (locate, analyze folder, …). */
export function setPanelNavigator(fn: Navigator): { dispose(): void } {
  navigator = fn;
  return {
    dispose: () => {
      if (navigator === fn) navigator = undefined;
    },
  };
}

/** Reveal the sidebar panel on a page. Resolves false when there is no panel (headless tests), so callers can fall back. */
export async function gotoPanel(g: Goto): Promise<boolean> {
  if (!navigator) return false;
  await navigator(g);
  return true;
}
