"use client";

import { useEffect } from "react";

const RELOAD_KEY = "coderyo:chunk-load-reload-at";
const RETRY_WINDOW_MS = 30_000;

function isChunkLoadFailure(value: unknown): boolean {
  const text =
    value instanceof Error
      ? `${value.name}\n${value.message}\n${value.stack ?? ""}`
      : typeof value === "string"
        ? value
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return "";
            }
          })();

  return (
    text.includes("ChunkLoadError") ||
    text.includes("Loading chunk") ||
    text.includes("/_next/static/chunks/")
  );
}

function reloadOnceForFreshChunks(): void {
  const now = Date.now();
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || "0");
  if (Number.isFinite(last) && now - last < RETRY_WINDOW_MS) return;
  sessionStorage.setItem(RELOAD_KEY, String(now));
  window.location.reload();
}

export function ChunkLoadRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (
        isChunkLoadFailure(event.error) ||
        isChunkLoadFailure(event.message) ||
        isChunkLoadFailure(event.filename)
      ) {
        reloadOnceForFreshChunks();
      }
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadFailure(event.reason)) reloadOnceForFreshChunks();
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
