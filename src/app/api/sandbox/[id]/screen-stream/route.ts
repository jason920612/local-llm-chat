import { NextRequest } from "next/server";
import {
  computerObserve,
  refreshScreenStream,
  readScreenFrame,
} from "@/lib/sandbox/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Live VM Console: a Server-Sent Events stream of downscaled JPEG frames of the
 * conversation's microVM screen (view-only). On connect we ensure the VM + virtual
 * desktop are up, then each tick we refresh the capture heartbeat (so the guest
 * grabs frames only while someone is watching) and push the latest frame as a
 * base64 data URL. Capture stops automatically when the last viewer disconnects.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const enc = new TextEncoder();
  const FPS_MS = 350; // ~2-3 fps

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let bootError: string | null = null;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };

      // Boot the VM + bring the desktop up (best-effort; non-blocking so the
      // stream can start sending "waiting" frames immediately while it comes
      // online). If boot fails, surface the error instead of spinning forever.
      void computerObserve(id, { includeScreenshot: false, ocr: false })
        .then((obs) => {
          if (!obs.ok) {
            bootError = obs.error ?? "VM display failed to start.";
            send({ type: "error", error: bootError });
          }
        })
        .catch((err) => {
          bootError = err instanceof Error ? err.message : String(err);
          send({ type: "error", error: bootError });
        });

      const tick = async () => {
        if (closed) return;
        refreshScreenStream(id);
        const frame = await readScreenFrame(id);
        if (frame && frame.length) {
          send({
            type: "frame",
            jpg: `data:image/jpeg;base64,${frame.toString("base64")}`,
            ts: Date.now(),
          });
        } else if (bootError) {
          send({ type: "error", error: bootError });
        } else {
          send({ type: "waiting" });
        }
      };

      const timer = setInterval(() => {
        void tick();
      }, FPS_MS);
      // Fire one immediately so the client sees a heartbeat right away.
      void tick();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
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
