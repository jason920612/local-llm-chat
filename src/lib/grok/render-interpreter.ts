export type AppMediaKind = "image" | "video" | "file" | "artifact";

export type RenderNode =
  | { kind: "text"; text: string }
  | { kind: "app_media"; media: AppMediaKind; ref: string }
  | {
      kind: "grok_searched_image";
      imageId: string;
      size: string;
      attrs: Record<string, string>;
    };

type SpanDirective = {
  start: number;
  end: number;
  node: Exclude<RenderNode, { kind: "text" }>;
};

function decodeGrokValue(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeSize(size: string): string {
  return decodeGrokValue(size || "SMALL").toUpperCase();
}

function isAppMediaKind(value: string): value is AppMediaKind {
  return (
    value === "image" ||
    value === "video" ||
    value === "file" ||
    value === "artifact"
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\b([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const m of source.matchAll(re)) {
    attrs[m[1]] = decodeGrokValue(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function parseArgumentElements(source: string): Record<string, string> {
  const args: Record<string, string> = {};

  const paired =
    /<argument\b([^>]*)>([\s\S]*?)<\/argument>/gi;
  for (const m of source.matchAll(paired)) {
    const attrs = parseAttributes(m[1] ?? "");
    const name = attrs.name;
    if (!name) continue;
    args[name] = decodeGrokValue(m[2] ?? "");
  }

  const selfClosing = /<argument\b([^>]*)\/>/gi;
  for (const m of source.matchAll(selfClosing)) {
    const attrs = parseAttributes(m[1] ?? "");
    const name = attrs.name;
    if (!name) continue;
    args[name] = decodeGrokValue(attrs.value ?? "");
  }

  return args;
}

function makeSearchedImageNode(
  imageId: string,
  size: string,
  attrs: Record<string, string> = {},
): Exclude<RenderNode, { kind: "text" }> | null {
  const id = decodeGrokValue(imageId);
  if (!id) return null;
  return {
    kind: "grok_searched_image",
    imageId: id,
    size: normalizeSize(size),
    attrs,
  };
}

function pushDirective(
  directives: SpanDirective[],
  start: number,
  raw: string,
  node: Exclude<RenderNode, { kind: "text" }> | null,
): void {
  if (!node) return;
  directives.push({ start, end: start + raw.length, node });
}

function collectAppMarkers(text: string, directives: SpanDirective[]): void {
  const re = /\[\[(image|video|file|artifact):([^\]\n]+)\]\]/gi;
  for (const m of text.matchAll(re)) {
    const media = (m[1] ?? "").toLowerCase();
    if (!isAppMediaKind(media)) continue;
    pushDirective(directives, m.index ?? 0, m[0], {
      kind: "app_media",
      media,
      ref: (m[2] ?? "").trim(),
    });
  }
}

function collectNaturalGrokImages(
  text: string,
  directives: SpanDirective[],
): void {
  const bracket =
    /\[\[\s*(?:render\s+)?render_searched_image\s+with\s+image_id\s+is\s+([^\s\]\*]+)(?:\s+size\s+is\s+(?:"([^"\n]+)"|([A-Za-z]+)))?\s*\]\]/gi;
  for (const m of text.matchAll(bracket)) {
    pushDirective(
      directives,
      m.index ?? 0,
      m[0],
      makeSearchedImageNode(m[1] ?? "", m[2] ?? m[3] ?? "SMALL"),
    );
  }

  const bare =
    /(?:\*\*)?(?:render\s+)?render_searched_image\s+with\s+image_id\s+is\s+([^\s\]\*]+)(?:\s+size\s+is\s+(?:"([^"\n]+)"|([A-Za-z]+)))?(?:\*\*)?/gi;
  for (const m of text.matchAll(bare)) {
    pushDirective(
      directives,
      m.index ?? 0,
      m[0],
      makeSearchedImageNode(m[1] ?? "", m[2] ?? m[3] ?? "SMALL"),
    );
  }
}

function collectGrokXml(text: string, directives: SpanDirective[]): void {
  const paired = /<grok:render\b([^>]*)>([\s\S]*?)<\/grok:render>/gi;
  for (const m of text.matchAll(paired)) {
    const attrs = parseAttributes(m[1] ?? "");
    const args = parseArgumentElements(m[2] ?? "");
    if (attrs.type !== "render_searched_image") continue;
    pushDirective(
      directives,
      m.index ?? 0,
      m[0],
      makeSearchedImageNode(
        args.image_id ?? attrs.image_id ?? "",
        args.size ?? attrs.size ?? "SMALL",
        attrs,
      ),
    );
  }

  const selfClosing = /<grok:render\b([^>]*)\/>/gi;
  for (const m of text.matchAll(selfClosing)) {
    const attrs = parseAttributes(m[1] ?? "");
    if (attrs.type !== "render_searched_image") continue;
    pushDirective(
      directives,
      m.index ?? 0,
      m[0],
      makeSearchedImageNode(
        attrs.image_id ?? "",
        attrs.size ?? "SMALL",
        attrs,
      ),
    );
  }
}

function nonOverlapping(directives: SpanDirective[]): SpanDirective[] {
  directives.sort((a, b) => {
    const start = a.start - b.start;
    if (start !== 0) return start;
    return b.end - b.start - (a.end - a.start);
  });

  const result: SpanDirective[] = [];
  let coveredUntil = -1;
  for (const directive of directives) {
    if (directive.start < coveredUntil) continue;
    result.push(directive);
    coveredUntil = directive.end;
  }
  return result;
}

export function interpretGrokRenderSyntax(text: string): RenderNode[] {
  const directives: SpanDirective[] = [];
  collectAppMarkers(text, directives);
  collectGrokXml(text, directives);
  collectNaturalGrokImages(text, directives);

  const nodes: RenderNode[] = [];
  let cursor = 0;
  for (const directive of nonOverlapping(directives)) {
    if (directive.start > cursor) {
      nodes.push({ kind: "text", text: text.slice(cursor, directive.start) });
    }
    nodes.push(directive.node);
    cursor = directive.end;
  }

  if (cursor < text.length || nodes.length === 0) {
    nodes.push({ kind: "text", text: text.slice(cursor) });
  }

  return nodes;
}
