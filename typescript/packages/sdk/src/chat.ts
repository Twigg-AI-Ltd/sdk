// A handle on one chat, so the common case never touches `input` arrays or repeats the model.
import type { PagePromise } from "./core/pagination.js";
import type { RequestOptions } from "./core/transport.js";
import { type MessageInput, toParts } from "./input.js";
import type { ChatRef, Chats, HistoryPage } from "./resources/chats.js";
import type { ExternalResponseRequest, ResponseRequest, Responses } from "./resources/responses.js";
import type { ResponseStream, StreamOptions } from "./streaming/response-stream.js";
import type { ResponseResult } from "./streaming/result.js";
import { type RunToolsRequest, ToolRunner } from "./tools/runner.js";
import type {
  AbortAccepted,
  ChatCreated,
  ChatId,
  ChatSummary,
  ExternalChatId,
  HistoryPart,
  HistoryQuery,
  ImportPart,
  ImportResult,
  OpenChatRequest,
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

/** What a chat handle's calls share, whichever way the handle addresses the chat. */
abstract class ChatHandle {
  constructor(
    protected readonly chats: Chats,
    protected readonly responses: Responses,
    readonly defaults: ChatDefaults,
  ) {}

  /** How this handle addresses the chat. */
  protected abstract get ref(): ChatRef;

  /** Send a message and wait for the full answer. */
  send(input: MessageInput, options: SendOptions = {}): Promise<ResponseResult> {
    return this.stream(input, options).final();
  }

  /** Send a message and stream the answer. */
  stream(input: MessageInput, options: SendOptions = {}): ResponseStream {
    const [request, streamOptions] = split(options);
    return this.responses.createAt(
      this.ref,
      { ...this.defaults, ...request, input: toParts(input) } as ExternalResponseRequest,
      streamOptions,
    );
  }

  /** Send a message and run the tool loop until the model stops calling tools. */
  runTools(input: MessageInput, options: ChatToolOptions = {}): ToolRunner {
    const [request, streamOptions] = split(options);
    return new ToolRunner(
      this.responses,
      this.ref,
      { ...this.defaults, ...request, input: toParts(input) } as RunToolsRequest,
      streamOptions,
    );
  }

  /** Retry the latest failed run without adding input. */
  retry(runId: RunId, options: SendOptions = {}): ResponseStream {
    const [request, streamOptions] = split(options);
    return this.responses.createAt(
      this.ref,
      { ...this.defaults, ...request, input: [], retry_of: runId } as ResponseRequest,
      streamOptions,
    );
  }

  history(query?: HistoryQuery, options?: RequestOptions): PagePromise<HistoryPart, HistoryPage> {
    return this.chats.historyAt(this.ref, query, options);
  }

  get(options?: RequestOptions): Promise<ChatSummary> {
    return this.chats.getAt(this.ref, options);
  }

  delete(options?: RequestOptions): Promise<void> {
    return this.chats.deleteAt(this.ref, options);
  }

  /** Stop the turn in progress, or only `runId` when given. */
  abort(runId?: RunId, options?: RequestOptions): Promise<AbortAccepted> {
    return this.responses.abortAt(this.ref, runId ? { run_id: runId } : {}, options);
  }
}

export class Chat extends ChatHandle {
  constructor(
    chats: Chats,
    responses: Responses,
    readonly id: ChatId,
    defaults: ChatDefaults = {},
    /**
     * The chat's record, when this handle came from `chats.open`, or from a listing or `get`
     * passed to `twigg.chat`.
     */
    readonly data?: ChatCreated | ChatSummary,
  ) {
    super(chats, responses, defaults);
  }

  protected get ref(): ChatRef {
    return this.id;
  }
}

/** Defaults for a chat addressed by external id: request fields, plus how to create the chat. */
export type ExternalChatDefaults = ChatDefaults & {
  /**
   * How to create the chat if no chat holds the external id yet, sent with every turn. On an
   * existing chat it is ignored, except that a `namespace` differing from the chat's is refused
   * with 409 `external_id_namespace_mismatch`.
   */
  chat?: OpenChatRequest | null;
};

/**
 * A handle on the chat holding an external id, your own identifier for it such as a phone number.
 * Every call addresses the chat by that id, so none needs Twigg's chat id, and the first turn
 * creates the chat if no chat holds the id yet: one request per message.
 */
export class ExternalChat extends ChatHandle {
  declare readonly defaults: ExternalChatDefaults;

  constructor(
    chats: Chats,
    responses: Responses,
    readonly externalId: ExternalChatId,
    defaults: ExternalChatDefaults = {},
  ) {
    super(chats, responses, defaults);
  }

  protected get ref(): ChatRef {
    return { externalId: this.externalId };
  }

  /**
   * Store an existing conversation as this chat's history, creating the chat from `defaults.chat`
   * if no chat holds the id yet; see `chats.importByExternalId`. A chat that already has history
   * answers `skipped: true` and is left as it was.
   */
  importHistory(parts: ImportPart[], options?: RequestOptions): Promise<ImportResult> {
    return this.chats.importByExternalId(
      this.externalId,
      { parts, ...(this.defaults.chat ? { chat: this.defaults.chat } : {}) },
      options,
    );
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
