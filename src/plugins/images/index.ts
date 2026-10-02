// Looking at pictures: image_view shows an image (a workspace file or a web address) to the brain, for describing it,
// answering questions about it ("are there cats in it?"), reading text in it. Only brains that can see images get the
// picture (Claude Code: as an image in the tool result); others get a note that they can't.
import { readFile, stat } from "node:fs/promises";
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { isPrivatePath, wsPath } from "../../core/workspace.js";
import { markPrivate } from "../../core/session.js";
import { holdImage, sniffImage, MAX_IMAGE_BYTES } from "../../core/images.js";
import { fetchPublic } from "../../core/net.js";

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export default (app: App) => definePlugin({
  name: "images",
  description: "Look at images: describe them, answer questions about them, read text in them",
  tools: [
    defineTool({
      name: "image_view",
      description: "Look at an image: a file in the workspace (e.g. uploads/2026-10-01/cat.jpg) or a web address " +
        "(https://…). The image is shown to you with the result, so you can describe it or answer questions about it. " +
        "PNG, JPEG, GIF or WebP, up to 5 MB. Look at several by calling it once per image.",
      tags: ["image", "picture", "photo", "vision", "see", "look", "describe", "screenshot", "bilde"],
      schema: z.object({ source: z.string().describe("Workspace path, /files/<path> link, or https:// URL of the image") }),
      run: async ({ source }, ctx) => {
        let bytes: Buffer, from: string;
        if (/^https?:\/\//i.test(source)) {
          const res = await fetchPublic(app.settings, source, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) los/0.1", accept: "image/*" }, signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error(`couldn't fetch the image: HTTP ${res.status}`);
          const len = Number(res.headers.get("content-length") ?? 0);
          if (len > MAX_IMAGE_BYTES) throw new Error(`the image is ${kb(len)}; the limit is ${kb(MAX_IMAGE_BYTES)}`);
          bytes = Buffer.from(await res.arrayBuffer());
          from = source;
        } else {
          const rel = decodeURIComponent(source.replace(/^\/?files\//, "").split(/[?#]/)[0]);
          const { full, rel: clean } = wsPath(app, rel);
          if (isPrivatePath(ctx.db, clean)) {
            if (!ctx.brainIsLocal) throw new Error(`"${clean}" is private`);
            markPrivate(ctx.db, ctx.sessionId);
          }
          const st = await stat(full).catch(() => null);
          if (!st?.isFile()) throw new Error(`no image "${clean}" in the workspace`);
          if (st.size > MAX_IMAGE_BYTES) throw new Error(`"${clean}" is ${kb(st.size)}; the limit is ${kb(MAX_IMAGE_BYTES)}`);
          bytes = await readFile(full);
          from = clean;
        }
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`the image is ${kb(bytes.length)}; the limit is ${kb(MAX_IMAGE_BYTES)}`);
        const mime = sniffImage(bytes);
        if (!mime) throw new Error("that isn't a PNG, JPEG, GIF or WebP image");
        return `Image ${from} (${mime}, ${kb(bytes.length)}): ${holdImage(bytes, mime)}`;
      },
    }),
  ],
});
