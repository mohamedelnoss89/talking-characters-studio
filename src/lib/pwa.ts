/**
 * Client-side PWA detection utilities.
 *
 * Used by <PWAGuard> to decide whether the current session is running
 * inside an installed PWA (standalone display mode) or just a regular
 * browser tab.
 *
 * NOTE: This module is browser-only. It guards every access with
 * `typeof window !== "undefined"` so it can be imported from server
 * components without crashing the build.
 */

/** Key used to remember users who clicked "continue in browser anyway". */
export const PWA_BYPASS_KEY = "tcs_pwa_bypass";

/**
 * Returns true when the app is running inside its own installed window
 * (PWA standalone mode), on either Chromium browsers, iOS Safari, or
 * any browser that matches the CSS media query `display-mode: standalone`.
 */
export function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;

  // 1. CSS media query — works on Chromium / Firefox / Samsung
  if (window.matchMedia("(display-mode: standalone)").matches) return true;

  // 2. iOS Safari exposes a non-standard `navigator.standalone` boolean
  if ((window.navigator as any).standalone === true) return true;

  // 3. Newer spec: window.caches + display-mode minimal-ui still counts
  //    as "installed" on some Android browsers (Samsung Internet).
  if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;

  return false;
}

/**
 * Returns true if the user has explicitly chosen to continue in the
 * browser (clicked the subtle "continue in browser anyway" link on
 * the install page). We persist this in localStorage so the guard
 * doesn't bounce them back to /install on every navigation.
 */
export function hasBypassFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(PWA_BYPASS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark that the user wants to skip the install gate (browser fallback). */
export function setBypassFlag(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PWA_BYPASS_KEY, "1");
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

/** Clear the bypass flag (e.g., after the app is actually installed). */
export function clearBypassFlag(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PWA_BYPASS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The single source of truth for the gate. Returns true when the user
 * should be allowed to see protected pages (`/`, `/login`, `/register`).
 *
 * Returns true when:
 *   - The app is running in standalone (installed) mode, OR
 *   - The user has a saved bypass flag in localStorage
 */
export function shouldAllowAccess(): boolean {
  return isStandaloneMode() || hasBypassFlag();
}
