import { GIFEncoder, quantize, applyPalette } from "gifenc";

export interface ExportGifOptions {
  urls: string[];
  fps?: number;
  maxDimension?: number;
  onProgress?: (progress: number, stage: "loading" | "encoding", detail?: string) => void;
}

export async function createGifFromImageUrls({
  urls,
  fps = 5,
  maxDimension = 720,
  onProgress,
}: ExportGifOptions): Promise<Blob> {
  if (!urls.length) {
    throw new Error("No image URLs provided for GIF export.");
  }

  const loadedImages: HTMLImageElement[] = [];
  const total = urls.length;

  // Step 1: Fetch and decode images
  for (let i = 0; i < total; i++) {
    const url = urls[i];
    const progress = Math.round(((i + 1) / total) * 50);
    onProgress?.(progress, "loading", `Loading frame ${i + 1}/${total}`);
    
    // Yield to UI thread to allow progress updates
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const img = await loadImageSafe(url);
      loadedImages.push(img);
    } catch (e) {
      console.warn(`Failed to load frame ${i + 1} (${url}):`, e);
    }
  }

  if (!loadedImages.length) {
    throw new Error("Failed to load images from NOAA servers. Please check your network connection.");
  }

  // Step 2: Compute dimensions (keep aspect ratio, max bounds, even dimensions)
  const first = loadedImages[0];
  const origW = first.naturalWidth || first.width || 800;
  const origH = first.naturalHeight || first.height || 800;

  let targetW = origW;
  let targetH = origH;
  if (origW > maxDimension || origH > maxDimension) {
    if (origW >= origH) {
      targetW = maxDimension;
      targetH = Math.round((origH / origW) * maxDimension);
    } else {
      targetH = maxDimension;
      targetW = Math.round((origW / origH) * maxDimension);
    }
  }

  // Enforce even dimensions for optimal encoder compatibility
  targetW = Math.max(2, targetW - (targetW % 2));
  targetH = Math.max(2, targetH - (targetH % 2));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create canvas 2D rendering context");

  // Step 3: Encode GIF frames with gifenc
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, fps));
  const numFrames = loadedImages.length;

  for (let i = 0; i < numFrames; i++) {
    const progress = 50 + Math.round(((i + 1) / numFrames) * 50);
    onProgress?.(progress, "encoding", `Encoding frame ${i + 1}/${numFrames}`);

    // Yield to keep UI responsive
    await new Promise((resolve) => setTimeout(resolve, 0));

    const img = loadedImages[i];
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    const rgba = imageData.data;

    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);

    gif.writeFrame(index, targetW, targetH, {
      palette,
      delay,
      repeat: 0, // Loop forever
    });
  }

  gif.finish();
  const bytes = gif.bytes();
  return new Blob([bytes], { type: "image/gif" });
}

async function loadImageSafe(url: string): Promise<HTMLImageElement> {
  // First try fetching as blob to prevent canvas tainting across domains
  try {
    const res = await fetch(url, { mode: "cors" });
    if (res.ok) {
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(blobUrl);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          reject(new Error("Failed to decode image blob"));
        };
        img.src = blobUrl;
      });
    }
  } catch {
    // Fall back to Image crossOrigin anonymous
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
