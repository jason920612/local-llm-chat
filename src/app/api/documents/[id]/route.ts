import { NextRequest } from "next/server";
import { deleteDocument } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  deleteDocument(id);
  return Response.json({ ok: true });
}
