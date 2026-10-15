// Server-sent events parser (https://html.spec.whatwg.org/multipage/server-sent-events.html),
// adapted from twigg-agent. Robust to arbitrary chunk boundaries, including a \r\n split in two.

export interface SseFrame {
  event: string;
  data: string;
}

/** Thrown when no bytes arrive for `idleTimeout` milliseconds. */
export class IdleTimeout extends Error {
  override name = "IdleTimeout";
}

/**
 * Parse a byte stream into SSE frames. Cancels the underlying stream when the consumer stops
 * early, reading fails, or nothing arrives for `idleTimeout` milliseconds.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  idleTimeout?: number,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];

  function* flushLines(final: boolean): Generator<SseFrame> {
    let start = 0;
    while (start < buffer.length) {
      const cr = buffer.indexOf("\r", start);
      const lf = buffer.indexOf("\n", start);
      if (cr === -1 && lf === -1) break;
      const end = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
      let next = end + 1;
      if (buffer[end] === "\r") {
        // A trailing \r may be the first half of \r\n split across chunks.
        if (end === buffer.length - 1 && !final) break;
        if (buffer[end + 1] === "\n") next = end + 2;
      }
      const frame = processLine(buffer.slice(start, end));
      if (frame) yield frame;
      start = next;
    }
    buffer = buffer.slice(start);
  }

  function processLine(line: string): SseFrame | undefined {
    if (line === "") {
      if (data.length === 0) {
        event = "";
        return undefined;
      }
      const frame = { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  }

  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await read(reader, idleTimeout, signal);
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* flushLines(false);
    }
    buffer += decoder.decode();
    yield* flushLines(true);
    // Lenient: dispatch a final event even if the stream ended without a blank line.
    if (buffer !== "") {
      const frame = processLine(buffer);
      buffer = "";
      if (frame) yield frame;
    }
    const last = processLine("");
    if (last) yield last;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleTimeout === undefined && !signal) return reader.read();
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Rejects on silence or on abort, so a pending read never outlives either; the caller's
  // finally then cancels the body.
  const interrupted = new Promise<never>((_, reject) => {
    if (idleTimeout !== undefined)
      timer = setTimeout(
        () => reject(new IdleTimeout(`No data for ${idleTimeout}ms`)),
        idleTimeout,
      );
    onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([reader.read(), interrupted]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

/** Serialise one event as an SSE frame. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
