import { NextRequest } from "next/server";
import { listSandboxFiles } from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** List all files in a conversation's sandbox workspace. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return Response.json({ files: await listSandboxFiles(id) });
}
