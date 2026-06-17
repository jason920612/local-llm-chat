import { NextRequest } from "next/server";
import { readSandboxFile } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Map safe raster image extensions to MIME types, so screenshots/images render
 * in an <img> tag instead of being served as opaque downloads. SVG stays out of
 * this allowlist because sandbox-authored SVG can carry active content. */
function imageMimeByExt(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

/** Serve a file from a conversation's sandbox (for the viewer / download). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  const file = await readSandboxFile(id, name);
  if (!file) return Response.json({ error: "not found" }, { status: 404 });

  const download = req.nextUrl.searchParams.get("download") === "1";
  const base = name.split("/").pop() || "file";
  const imageMime = download ? null : imageMimeByExt(name);
  return new Response(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": imageMime
        ? imageMime
        : file.isText
          ? "text/plain; charset=utf-8"
          : "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(download
        ? { "Content-Disposition": `attachment; filename="${base}"` }
        : {}),
    },
  });
}
