// Attachments: bytes in, base64 out, with a MIME type and an optional local check against a
// model's published limits.
import type { CatalogueModel, HistoryPart, SubmittedMedia, SubmittedPart } from "./types.js";

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** Build an attachment from bytes. */
export function fromBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,
  filename?: string,
): SubmittedMedia {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { mime, data_base64: toBase64(data), filename: filename ?? null };
}

/** Build an attachment from standard base64, without a data-URI prefix. */
export function fromBase64(data: string, mime: string, filename?: string): SubmittedMedia {
  if (data.startsWith("data:"))
    throw new TypeError("Pass the base64 payload without its data: URI prefix");
  return { mime, data_base64: data, filename: filename ?? null };
}

/**
 * Read a file into an attachment. Node, Bun and Deno only. The MIME type comes from the
 * extension or the file's first bytes unless given.
 */
export async function fromFile(
  path: string,
  options: { mime?: string } = {},
): Promise<SubmittedMedia> {
  // Through a variable, so edge bundlers do not try to bundle a module they cannot run.
  const specifier = "node:fs/promises";
  const fs = (await import(specifier)) as { readFile(path: string): Promise<Uint8Array> };
  const bytes = new Uint8Array(await fs.readFile(path));
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  const mime = options.mime ?? guessMime(filename, bytes);
  if (!mime) throw new TypeError(`Cannot tell the MIME type of ${filename}; pass options.mime`);
  return fromBytes(bytes, mime, filename);
}

/** Download a URL into an attachment, taking the MIME type from the response. */
export async function fromUrl(
  url: string | URL,
  options: { mime?: string; fetch?: typeof fetch } = {},
): Promise<SubmittedMedia> {
  const response = await (options.fetch ?? fetch)(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const filename = new URL(String(url)).pathname.split("/").at(-1) || undefined;
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  const mime = options.mime ?? header ?? guessMime(filename ?? "", bytes);
  if (!mime) throw new TypeError(`Cannot tell the MIME type of ${url}; pass options.mime`);
  return fromBytes(bytes, mime, filename);
}

/** The MIME type from a filename's extension, then from well-known leading bytes. */
export function guessMime(filename: string, bytes?: Uint8Array): string | undefined {
  const extension = filename.includes(".") ? filename.split(".").at(-1)?.toLowerCase() : undefined;
  if (extension && BY_EXTENSION[extension]) return BY_EXTENSION[extension];
  if (!bytes) return undefined;
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return undefined;
}

/** Where an attachment travels, which decides the limits that apply. */
export type MediaCarrier = "user" | "tool_result";

/**
 * Problems Twigg would reject these attachments for on this model, checked locally: unsupported
 * types, oversized files and too many attachments. An empty list means they fit.
 */
export function check(
  model: Pick<CatalogueModel, "name" | "media">,
  attachments: SubmittedMedia[],
  carrier: MediaCarrier = "user",
): string[] {
  const policy = model.media[carrier];
  const problems: string[] = [];
  if (attachments.length > model.media.max_attachments_per_part)
    problems.push(
      `${model.name} accepts at most ${model.media.max_attachments_per_part} attachments per part`,
    );
  if (
    policy.max_attachments_per_request != null &&
    attachments.length > policy.max_attachments_per_request
  )
    problems.push(
      `${model.name} accepts at most ${policy.max_attachments_per_request} ${carrier} attachments per request`,
    );
  for (const item of attachments) {
    const name = item.filename ?? item.mime;
    if (!policy.mime_types.some((pattern) => mimeMatches(pattern, item.mime)))
      problems.push(`${model.name} does not accept ${item.mime} (${name}) in ${carrier} parts`);
    const size = decodedSize(item.data_base64);
    if (size > policy.max_bytes_per_attachment)
      problems.push(
        `${name} is ${size} bytes; ${model.name} accepts at most ${policy.max_bytes_per_attachment}`,
      );
  }
  return problems;
}

/**
 * A stored prompt or tool result as a part to submit again. Attachments come along only when
 * the history was read with `include: "full"`. Assistant-authored parts cannot be submitted.
 */
export function toSubmittable(part: HistoryPart): SubmittedPart {
  const media = (part.media ?? []).flatMap((m) =>
    m.data_base64
      ? [{ mime: m.mime, data_base64: m.data_base64, filename: m.filename ?? null }]
      : [],
  );
  const body = part.part;
  switch (body.type) {
    case "prompt":
      return { type: "prompt", text: body.text, ...(media.length ? { media } : {}) };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: body.tool_use_id,
        tool_name: body.tool_name,
        text: body.text,
        is_error: body.is_error,
        trust: body.trust,
        ...(media.length ? { media } : {}),
      };
    default:
      throw new TypeError(`A ${body.type} part was written by the model and cannot be submitted`);
  }
}

function mimeMatches(pattern: string, mime: string): boolean {
  if (pattern === mime || pattern === "*/*") return true;
  return pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1));
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const buffer = (
    globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } }
  ).Buffer;
  if (buffer) return buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Attachment helpers: `media.fromFile("chart.png")` and friends. */
export const media = { fromBytes, fromBase64, fromFile, fromUrl, guessMime, check, toSubmittable };
