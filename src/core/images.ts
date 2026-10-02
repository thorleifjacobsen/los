// Images for brains that can see them. A tool (image_view) loads an image and puts a marker in its text result:
// ⟦image:<id>⟧. The picture itself stays out of the conversation log (only the note is stored); the marker is turned
// into a real image where the brain's protocol allows it: in the MCP tool result for CLI agents (Claude Code), and
// replaced by a short note for brains that only get text. Held in memory for an hour: long enough for the step that
// asked for it.
import { randomBytes } from "node:crypto";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // what Claude accepts per image
const MARKER = /⟦image:([\w-]+)⟧/g;
const held = new Map<string, { data: string; mime: string; at: number }>();

/** Keep an image for the next send; returns the marker to put in the tool's text result. */
export function holdImage(bytes: Buffer, mime: string): string {
  for (const [k, v] of held) if (Date.now() - v.at > 3600_000) held.delete(k);
  const id = randomBytes(9).toString("base64url");
  held.set(id, { data: bytes.toString("base64"), mime, at: Date.now() });
  return `⟦image:${id}⟧`;
}
/** A tool result's text without markers, and the images they stood for (still in memory). */
export function takeImages(content: string): { text: string; images: { data: string; mime: string }[] } {
  const images: { data: string; mime: string }[] = [];
  const text = content.replace(MARKER, (_, id) => {
    const img = held.get(id);
    if (img) images.push({ data: img.data, mime: img.mime });
    return img ? "[image attached]" : "[image no longer available]";
  });
  return { text, images };
}
/** For brains that only take text. */
export const withoutImages = (content: string) => content.replace(MARKER, "[an image was loaded here, but this brain can only read text]");

/** What kind of image these bytes are (by their first bytes, not the file name), or null. */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
