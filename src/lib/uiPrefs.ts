"use client";

import { useEffect, useState } from "react";

/**
 * Per-device UI preferences (localStorage, not server settings — they only affect
 * how this browser behaves). Changes broadcast a custom event so open components
 * react live, and the native `storage` event keeps other tabs in sync.
 */
const AUTO_SCROLL_KEY = "ui.autoScroll";
const PREFS_EVENT = "ui-prefs-changed";

export function getAutoScroll(): boolean {
  if (typeof window === "undefined") return true;
  // Default ON (current behaviour): only "false" disables it.
  return window.localStorage.getItem(AUTO_SCROLL_KEY) !== "false";
}

export function setAutoScroll(on: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTO_SCROLL_KEY, on ? "true" : "false");
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
}

/** React to the auto-scroll preference, live across this tab and other tabs. */
export function useAutoScrollPref(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const sync = () => setEnabled(getAutoScroll());
    sync();
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return enabled;
}
