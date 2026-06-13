"use client";

/** Load an <img> element from a data URL (browser only). */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/**
 * Read an image file and downscale it to `maxDim` (longest side) as JPEG.
 * Keeps multimodal payloads small enough for a local model to handle quickly.
 */
export async function fileToResizedDataURL(
  file: File,
  maxDim = 1280,
  quality = 0.85,
): Promise<string> {
  const dataUrl = await readAsDataURL(file);
  try {
    const img = await loadImage(dataUrl);
    const longest = Math.max(img.width, img.height);
    if (longest <= maxDim) return dataUrl;

    const scale = maxDim / longest;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl; // fall back to the original on any decode failure
  }
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
