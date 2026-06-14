import { NextRequest } from "next/server";
import { subscribeGlobal, type GlobalEvent } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * App-wide Server-Sent Events: conversation list changes (create/rename/delete)
 * and which conversations are currently generating — so the sidebar and active
 * state stay in sync across all open devices.
 */
export async function GET(req: NextRequest) {
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: GlobalEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* ignore */
        }
      };
      const unsub = subscribeGlobal(send);
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
