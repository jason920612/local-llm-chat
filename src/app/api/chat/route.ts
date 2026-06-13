import { NextRequest } from "next/server";
import { runControlledChat } from "@/lib/sop/pipeline";
import type { ChatRequestBody } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // video generation polling can take minutes

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // All SOP enforcement (intent gate, validators, verify gate, blocking mode)
  // is handled in code inside the controlled pipeline — not by the prompt.
  return runControlledChat(body);
}
