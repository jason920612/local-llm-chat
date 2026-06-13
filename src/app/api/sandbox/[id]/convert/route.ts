import { NextRequest } from "next/server";
import { convertToPdf } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Convert a sandbox office file (pptx/docx/xlsx…) to PDF for in-app preview. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  const pdf = await convertToPdf(id, name);
  if (!pdf) {
    return Response.json(
      { error: "conversion unavailable (LibreOffice not installed?)" },
      { status: 501 },
    );
  }
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store",
    },
  });
}
