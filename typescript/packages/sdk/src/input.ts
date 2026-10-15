import type { SubmittedMedia, SubmittedPart } from "./types.js";

/** Anything `chat.send` accepts: text, attachments, ready-made parts, or a mix. */
export type MessageInput =
  | string
  | SubmittedMedia
  | SubmittedPart
  | (string | SubmittedMedia | SubmittedPart)[];

/**
 * Turn loose input into parts. Consecutive strings and attachments become one prompt, with the
 * strings joined by blank lines; ready-made parts pass through in place.
 */
export function toParts(input: MessageInput): SubmittedPart[] {
  const items = Array.isArray(input) ? input : [input];
  const parts: SubmittedPart[] = [];
  let text: string[] = [];
  let media: SubmittedMedia[] = [];
  const flush = () => {
    if (text.length === 0 && media.length === 0) return;
    parts.push({
      type: "prompt",
      ...(text.length ? { text: text.join("\n\n") } : {}),
      ...(media.length ? { media } : {}),
    });
    text = [];
    media = [];
  };
  for (const item of items) {
    if (typeof item === "string") text.push(item);
    else if ("type" in item) {
      flush();
      parts.push(item);
    } else media.push(item);
  }
  flush();
  return parts;
}
