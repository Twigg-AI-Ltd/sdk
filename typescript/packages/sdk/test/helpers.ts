import { type ClientOptions, Twigg } from "../src/index.js";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error | (() => Response | Promise<Response>);

/** A fetch that records every request and answers from a queue (default: 200 `{}`). */
export function fakeFetch() {
  const requests: RecordedRequest[] = [];
  const replies: Reply[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    requests.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers,
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    });
    const reply = replies.shift() ?? json({});
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    reply: (...next: Reply[]) => {
      replies.push(...next);
    },
    get last(): RecordedRequest {
      const request = requests.at(-1);
      if (!request) throw new Error("no requests were made");
      return request;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(status: number, code: string, message = code): Response {
  return json({ error: { code, message } }, status);
}

/** A client wired to a fake fetch, with retries that do not wait. */
export function setup(options: ClientOptions = {}) {
  const api = fakeFetch();
  const sleeps: number[] = [];
  const twigg = new Twigg({
    apiKey: "tw_test",
    baseURL: "https://api.test",
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { twigg, api, sleeps };
}

/** A byte stream delivering `text` in chunks of `size` bytes. */
export function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const RUN = "0192f0a0-0000-7000-8000-0000000000aa";
const CHAT = "0192f0a0-0000-7000-8000-0000000000cc";
export const ids = { run: RUN, chat: CHAT };

/** SSE text for a list of [event, data] pairs. */
export function sseText(events: [string, unknown][]): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

/** A 200 event-stream response. With `dropAfter`, the body errors once that text is sent. */
export function sseResponse(text: string, options: { dropAfter?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        if (options.dropAfter) controller.error(new TypeError("terminated"));
        else controller.close();
        return;
      }
      controller.enqueue(bytes);
      sent = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export const runEvent: [string, unknown] = [
  "run",
  { run_id: RUN, chat_id: CHAT, closed_tool_calls: [] },
];

export function doneEvent(overrides: Record<string, unknown> = {}): [string, unknown] {
  return [
    "done",
    {
      compaction: null,
      cost: "0.0010",
      cost_currency: "USD",
      model_served: "claude-opus-5",
      pending_tool_calls: [],
      provider_response_id: "msg_1",
      server_tools: null,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
      ...overrides,
    },
  ];
}

export function textTurn(text = "Hello"): string {
  return sseText([
    runEvent,
    ["config_warnings", { warnings: [] }],
    ["block_start", { kind: "text" }],
    ["delta", { kind: "text", text }],
    ["block_stop", {}],
    doneEvent(),
  ]);
}
