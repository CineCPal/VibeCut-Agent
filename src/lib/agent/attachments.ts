/**
 * Images sent with a message (Phase 8g): read from a file, a paste or a drop, made small enough for every
 * provider, filed beside the chat, and shown again from there.
 *
 * Limits match the sidecar's (agent/attachments.py): at most MAX_IMAGES per message, PNG/JPEG/WebP/GIF,
 * at most MAX_EDGE px on the long side and MAX_IMAGE_BYTES each (Claude refuses over 5 MB of base64).
 */
import { loadChatAttachment, saveChatAttachment } from "../ipc";
import { newId } from "../id";
import type { ChatAttachment, PendingImage } from "../../types/agent";

export const MAX_IMAGES = 4;
export const MAX_EDGE = 1568;
export const MAX_IMAGE_BYTES = 3_932_160;
/** A small enough image that's already within MAX_EDGE goes as it is (a screenshot stays a crisp PNG). */
export const KEEP_AS_IS_BYTES = 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** How an image of this size and type is sent: as it is, or redrawn at `scale` (≤ 1) in `type`. */
export function resizePlan(width: number, height: number, bytes: number, type: string): { keep: true } | { keep: false; scale: number; type: string } {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height, 1));
  if (scale === 1 && bytes <= KEEP_AS_IS_BYTES) return { keep: true };
  // A PNG that only needs shrinking stays a PNG unless it's still too big (redrawImage's fallback).
  return { keep: false, scale, type: type === "image/png" ? "image/png" : "image/jpeg" };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't redraw the image"))), type, quality),
  );
}

/** Redraws a decoded image at `scale` in `type`, falling back to JPEG (lower quality last) to fit. */
async function redrawImage(bitmap: ImageBitmap, scale: number, type: string): Promise<{ blob: Blob; width: number; height: number }> {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn't redraw the image");
  if (type === "image/png") {
    context.drawImage(bitmap, 0, 0, width, height);
    const png = await canvasBlob(canvas, "image/png");
    if (png.size <= KEEP_AS_IS_BYTES) return { blob: png, width, height };
  }
  // JPEG has no transparency: a white ground, as most editors show it.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  let blob = await canvasBlob(canvas, "image/jpeg", 0.85);
  if (blob.size > MAX_IMAGE_BYTES) blob = await canvasBlob(canvas, "image/jpeg", 0.7);
  return { blob, width, height };
}

/** An image from a file, a paste or a drop, ready to send. Throws, saying why, when it can't be. */
export async function prepareImage(blob: Blob, name: string): Promise<PendingImage> {
  if (!IMAGE_TYPES.includes(blob.type)) throw new Error(`${name} isn't a PNG, JPEG, WebP or GIF image`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(`${name} couldn't be read as an image`);
  }
  try {
    const plan = resizePlan(bitmap.width, bitmap.height, blob.size, blob.type);
    const out = plan.keep ? { blob, width: bitmap.width, height: bitmap.height } : await redrawImage(bitmap, plan.scale, plan.type);
    if (out.blob.size > MAX_IMAGE_BYTES) throw new Error(`${name} is still too big to send after shrinking it`);
    const dataUrl = await readAsDataUrl(out.blob);
    const mime = out.blob.type || blob.type;
    return {
      id: newId().replace(/[^\w-]/g, "").slice(0, 32),
      name,
      mime,
      width: out.width,
      height: out.height,
      bytes: out.blob.size,
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      dataUrl,
    };
  } finally {
    bitmap.close();
  }
}

/** The images among pasted or dropped files. */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
}

/** What a message keeps of an image: no bytes. */
export function attachmentOf(image: PendingImage): ChatAttachment {
  const { id, name, mime, width, height, bytes } = image;
  return { id, name, mime, width, height, bytes };
}

// Shown images, newest last, so a long chat doesn't hold every image it ever showed.
const CACHE_LIMIT = 40;
const cache = new Map<string, string>();

function remember(key: string, dataUrl: string): void {
  cache.delete(key);
  cache.set(key, dataUrl);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

/** Files the images beside the chat, and keeps them at hand to show. */
export async function saveImages(chatId: string, images: PendingImage[]): Promise<void> {
  for (const image of images) {
    await saveChatAttachment(chatId, image.id, image.mime, image.data);
    remember(`${chatId}/${image.id}`, image.dataUrl);
  }
}

/** An image of the chat's, as a data URL to show. */
export async function attachmentUrl(chatId: string, attachment: ChatAttachment): Promise<string> {
  const key = `${chatId}/${attachment.id}`;
  const known = cache.get(key);
  if (known) return known;
  const { mime, data } = await loadChatAttachment(chatId, attachment.id);
  const dataUrl = `data:${mime};base64,${data}`;
  remember(key, dataUrl);
  return dataUrl;
}

/** A message's images back as they were sent (Retry, Edit). */
export async function loadImages(chatId: string, attachments: ChatAttachment[] | undefined): Promise<PendingImage[]> {
  const images: PendingImage[] = [];
  for (const attachment of attachments ?? []) {
    const dataUrl = await attachmentUrl(chatId, attachment);
    images.push({ ...attachment, dataUrl, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  }
  return images;
}

/** Forgets every shown image (tests). */
export function clearAttachmentCache(): void {
  cache.clear();
}

/**
 * Adds images to the composer, up to MAX_IMAGES. Answers why any were left out, or null. Reads the store
 * through `get`/`set` so the composer and a drop on the chat share it.
 */
export async function addImagesTo(
  files: File[],
  get: () => PendingImage[],
  set: (images: PendingImage[]) => void,
  prepare: (blob: Blob, name: string) => Promise<PendingImage> = prepareImage,
): Promise<string | null> {
  const problems: string[] = [];
  for (const file of files) {
    if (get().length >= MAX_IMAGES) {
      problems.push(`At most ${MAX_IMAGES} images can go with one message`);
      break;
    }
    try {
      const image = await prepare(file, file.name || "Pasted image");
      set([...get(), image].slice(0, MAX_IMAGES));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems.length ? problems.join(". ") : null;
}
