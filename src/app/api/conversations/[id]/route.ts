import { NextRequest } from "next/server";
import {
  deleteConversation,
  getConversation,
  renameConversation,
} from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const data = getConversation(id);
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(data);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.title !== "string") {
    return Response.json({ error: "title required" }, { status: 400 });
  }
  renameConversation(id, body.title);
  return Response.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  deleteConversation(id);
  return Response.json({ ok: true });
}
