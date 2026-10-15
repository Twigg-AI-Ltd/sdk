// A handle on one chat, so the common case never touches `input` arrays or repeats the model.
import type { PagePromise } from "./core/pagination.js";
import type { RequestOptions } from "./core/transport.js";
import { type MessageInput, toParts } from "./input.js";
import type { Chats, HistoryPage } from "./resources/chats.js";
import type { ResponseRequest, Responses } from "./resources/responses.js";
import type { ResponseStream, StreamOptions } from "./streaming/response-stream.js";
import type { ResponseResult } from "./streaming/result.js";
import type { RunToolsRequest, ToolRunner } from "./tools/runner.js";
import type {
  AbortAccepted,
  ChatCreated,
  ChatId,
  ChatSummary,
  HistoryPart,
  HistoryQuery,
  RunId,
} from "./types.js";

/** Request fields a chat handle fills in when a call leaves them out. */
export type ChatDefaults = Partial<Omit<ResponseRequest, "input" | "idempotency_key" | "retry_of">>;

/** Per-call request fields plus stream options. */
export type SendOptions = Partial<Omit<ResponseRequest, "input">> & StreamOptions;
export type ChatToolOptions = Partial<Omit<RunToolsRequest, "input">> & StreamOptions;

const STREAM_OPTIONS = [
  "signal",
  "timeout",
  "maxRetries",
  "headers",
  "recover",
  "idleTimeout",
  "recoveryTimeout",
  "abortRun",
] as const;

export class Chat {
  constructor(
    private readonly chats: Chats,
    private readonly responses: Responses,
    readonly id: ChatId,
    readonly defaults: ChatDefaults = {},
    /**
     * The chat's record, when this handle came from `chats.open`, or from a listing or `get`
     * passed to `twigg.chat`.
     */
    readonly data?: ChatCreated | ChatSummary,
  ) {}

  /** Send a message and wait for the full answer. */
  send(input: MessageInput, options: SendOptions = {}): Promise<ResponseResult> {
    return this.stream(input, options).final();
  }

  /** Send a message and stream the answer. */
  stream(input: MessageInput, options: SendOptions = {}): ResponseStream {
    const [request, streamOptions] = split(options);
    return this.responses.create(
      this.id,
      { ...this.defaults, ...request, input: toParts(input) } as ResponseRequest,
      streamOptions,
    );
  }

  /** Send a message and run the tool loop until the model stops calling tools. */
  runTools(input: MessageInput, options: ChatToolOptions = {}): ToolRunner {
    const [request, streamOptions] = split(options);
    return this.responses.runTools(
      this.id,
      { ...this.defaults, ...request, input: toParts(input) } as RunToolsRequest,
      streamOptions,
    );
  }

  /** Retry the latest failed run without adding input. */
  retry(runId: RunId, options: SendOptions = {}): ResponseStream {
    const [request, streamOptions] = split(options);
    return this.responses.retry(
      this.id,
      runId,
      { ...this.defaults, ...request } as ResponseRequest,
      streamOptions,
    );
  }

  history(query?: HistoryQuery, options?: RequestOptions): PagePromise<HistoryPart, HistoryPage> {
    return this.chats.history(this.id, query, options);
  }

  get(options?: RequestOptions): Promise<ChatSummary> {
    return this.chats.get(this.id, options);
  }

  delete(options?: RequestOptions): Promise<void> {
    return this.chats.delete(this.id, options);
  }

  /** Stop the turn in progress, or only `runId` when given. */
  abort(runId?: RunId, options?: RequestOptions): Promise<AbortAccepted> {
    return this.responses.abort(this.id, runId ? { run_id: runId } : {}, options);
  }
}

function split<T extends StreamOptions>(options: T): [Omit<T, keyof StreamOptions>, StreamOptions] {
  const request = { ...options } as Record<string, unknown>;
  const stream: Record<string, unknown> = {};
  for (const key of STREAM_OPTIONS) {
    if (key in request) stream[key] = request[key];
    delete request[key];
  }
  return [request as Omit<T, keyof StreamOptions>, stream as StreamOptions];
}
