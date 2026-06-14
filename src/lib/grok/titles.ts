import type { Citation } from "../types";

/**
 * Best-effort web page <title> resolver for search-source citations.
 *
 * Grok's web/x search returns URLs only (no titles), so we fetch each source
 * server-side, pull its <title>, and cache the result. Everything here is
 * defensive: short timeout, capped download, and a domain-name fallback so a
 * slow or hostile URL never blocks or breaks the answer.
 */

const TIMEOUT_MS = 4000;
const MAX_BYTES = 200_000; // titles live in <head>; no need to read whole pages
const MAX_TITLE_LEN = 90;

// Process-lifetime cache (URL -> resolved title). Survives across turns.
const cache = new Map<string, string>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "source";
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#34": '"',
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return ENTITIES[name] ?? full;
  });
}

function extractTitle(html: string): string {
  // Prefer og:title (cleaner) then <title>.
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  const raw =
    og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return text.length > MAX_TITLE_LEN
    ? text.slice(0, MAX_TITLE_LEN - 1).trimEnd() + "…"
    : text;
}

async function fetchTitle(url: string): Promise<string> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  let title = "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // A real UA — some sites 403 the default fetch agent.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("html") && res.body) {
      // Read only enough bytes to find <head>/<title>.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = "";
      let read = 0;
      while (read < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (/<\/title>/i.test(html)) break; // got it — stop early
      }
      reader.cancel().catch(() => {});
      title = extractTitle(html);
    }
  } catch {
    /* timeout / network / abort — fall through to fallback */
  } finally {
    clearTimeout(timer);
  }

  const resolved = title || hostOf(url);
  cache.set(url, resolved);
  return resolved;
}

/**
 * Fill in `title` for each citation in place (web/x search sources only).
 * Runs all fetches in parallel; failures fall back to the domain name.
 */
export async function enrichCitationTitles(
  citations: Citation[],
): Promise<void> {
  await Promise.all(
    citations.map(async (c) => {
      if (c.title || c.documentId !== "grok") return;
      const url = c.snippet; // mapGrokCitations stores the URL here
      if (!url || !/^https?:\/\//i.test(url)) return;
      c.title = await fetchTitle(url);
    }),
  );
}
