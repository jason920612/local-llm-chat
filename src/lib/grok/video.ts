import { config } from "../config";
import { generateImage } from "./image";

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 180000; // 3 min — generation is async and slow

function maybeServiceTier(): Record<string, unknown> {
  return config.grok.serviceTier ? { service_tier: config.grok.serviceTier } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generate a video with Grok Imagine. Starts the async job, polls until done,
 * and returns the video URL. Throws on failure or timeout.
 */
export async function generateVideo(
  prompt: string,
  opts: { imageUrl?: string } = {},
): Promise<string> {
  if (!config.grok.enabled) {
    throw new Error("XAI_API_KEY is not set — video generation is disabled.");
  }

  // Use grok-imagine-video-1.5 for all video generation. It expects an image
  // input, so plain text video requests first create a still base image.
  const image = opts.imageUrl ?? (await generateImage(prompt));

  const start = await fetch(`${config.grok.baseURL}/videos/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: config.grok.videoModel,
      prompt,
      image: { url: image }, // xAI expects an ImageUrl object, not a string
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
      ...maybeServiceTier(),
    }),
  });
  if (!start.ok) {
    const detail = await start.text().catch(() => "");
    throw new Error(`xAI videos ${start.status}: ${detail.slice(0, 200)}`);
  }
  const { request_id: requestId } = await start.json();
  if (!requestId) throw new Error("xAI videos: no request_id returned");

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetch(`${config.grok.baseURL}/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${config.grok.apiKey}` },
    });
    if (!poll.ok) continue;
    const data = await poll.json();
    if (data.status === "done" && data.video?.url) return data.video.url;
    if (data.status === "failed" || data.status === "expired") {
      throw new Error(`video generation ${data.status}`);
    }
  }
  throw new Error("video generation timed out (still processing)");
}
