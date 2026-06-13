import { config } from "../config";

const IMAGE_MODEL = "grok-imagine-image-quality";

/**
 * Generate an image with Grok Imagine (xAI). Returns a displayable image src:
 * a hosted URL or a base64 data URI. Throws on API error.
 */
export async function generateImage(prompt: string): Promise<string> {
  if (!config.grok.enabled) {
    throw new Error("XAI_API_KEY is not set — image generation is disabled.");
  }

  const res = await fetch(`${config.grok.baseURL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`xAI images ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const item = data?.data?.[0];
  if (item?.url) return item.url as string;
  if (item?.b64_json) return `data:image/jpeg;base64,${item.b64_json}`;
  throw new Error("xAI images: no image returned");
}
