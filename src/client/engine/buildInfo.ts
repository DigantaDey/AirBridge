/**
 * Version of this UI bundle, injected by Vite (`define` in vite.config.ts).
 * Undefined when running unbundled (tests, tsx).
 */
declare const __AIRBRIDGE_UI_VERSION__: string | undefined;

export const UI_VERSION: string | undefined =
  typeof __AIRBRIDGE_UI_VERSION__ !== 'undefined' ? __AIRBRIDGE_UI_VERSION__ : undefined;

/**
 * True when the server runs a different build than this page — typically an
 * app window left open across an update, or a server restarted from a newer
 * install. Dev servers ("dev") and unknown versions never force a reload.
 */
export function isStaleUi(serverVersion: string | undefined | null, uiVersion: string | undefined = UI_VERSION): boolean {
  if (!serverVersion || !uiVersion) return false;
  if (serverVersion === 'dev' || uiVersion === 'dev') return false;
  return serverVersion !== uiVersion;
}

const RELOAD_KEY = 'airbridge.staleUiReload';

/**
 * Reloads the page once per server version (guards against a reload loop if
 * the server keeps serving a mismatched bundle). Returns true when a reload
 * was started.
 */
export function reloadForServerVersion(serverVersion: string): boolean {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return false;
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === serverVersion) return false;
    sessionStorage.setItem(RELOAD_KEY, serverVersion);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
