import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mint a short-lived ephemeral token for the xAI realtime voice WebSocket. */
export async function POST() {
  if (!config.grok.enabled) {
    return Response.json({ error: "XAI_API_KEY not set" }, { status: 503 });
  }
  const res = await fetch(`${config.grok.baseURL}/realtime/client_secrets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json(
      { error: `xAI realtime ${res.status}: ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const data = await res.json();
  return Response.json({ value: data.value, expiresAt: data.expires_at });
}
