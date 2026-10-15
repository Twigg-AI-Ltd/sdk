// Record real API traffic once, then replay it in tests. Recordings never include headers, so
// API keys stay out of fixture files.

export interface Recording {
  method: string;
  /** Path and query string. */
  url: string;
  requestBody: unknown;
  status: number;
  contentType: string | null;
  body: string;
}

/** A fetch that passes requests through and keeps a copy of each exchange. */
export function recordingFetch(inner: typeof fetch = globalThis.fetch): {
  fetch: typeof fetch;
  recordings: Recording[];
} {
  const recordings: Recording[] = [];
  const recording = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await inner(input, init);
    // Read whole: a recorded stream replays at once, which is all a test needs.
    const body = await response.text();
    const url = new URL(String(input));
    recordings.push({
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      requestBody: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return { fetch: recording as typeof fetch, recordings };
}

/**
 * A fetch answering from recordings in order. Each request must match the next unused recording
 * with the same method and path; anything else throws, so a test notices when its traffic
 * changes.
 */
export function replayFetch(recordings: Recording[]): typeof fetch {
  const used = new Set<number>();
  const replay = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const index = recordings.findIndex(
      (r, i) => !used.has(i) && r.method === method && r.url.split("?")[0] === url.pathname,
    );
    const match = recordings[index];
    if (!match) throw new Error(`No recording left for ${method} ${url.pathname}`);
    used.add(index);
    const headers = match.contentType ? { "content-type": match.contentType } : undefined;
    return new Response(match.status === 204 ? null : match.body, {
      status: match.status,
      headers,
    });
  };
  return replay as typeof fetch;
}

/** Save recordings as JSON. Node, Bun and Deno only. */
export async function saveRecordings(path: string, recordings: Recording[]): Promise<void> {
  const specifier = "node:fs/promises";
  const fs = (await import(specifier)) as { writeFile(p: string, d: string): Promise<void> };
  await fs.writeFile(path, `${JSON.stringify(recordings, null, 2)}\n`);
}

export async function loadRecordings(path: string): Promise<Recording[]> {
  const specifier = "node:fs/promises";
  const fs = (await import(specifier)) as { readFile(p: string, e: string): Promise<string> };
  return JSON.parse(await fs.readFile(path, "utf8")) as Recording[];
}
