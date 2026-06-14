import { NextRequest } from "next/server";
import { subscribeConv, type ConvEvent } from "@/lib/live/bus";
import { getConversationSnapshot } from "@/lib/live/generations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Server-Sent Events for one conversation: live tokens, message add/finalize,
 * branch switches, truncation — so every open device stays in sync. On connect
 * we replay any in-flight generation buffer so a late joiner catches up.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };

      // Catch-up: replay the current generation buffer, if any.
      const snap = getConversationSnapshot(id);
      if (snap) {
        send({
          type: "snapshot",
          messageId: snap.messageId,
          raw: snap.raw,
          status: snap.status,
        });
      }

      const unsub = subscribeConv(id, (e: ConvEvent) => send(e));
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* ignore */
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
