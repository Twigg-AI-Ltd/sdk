import { Resource } from "../core/resource.js";
import type { RequestOptions, Transport } from "../core/transport.js";
import { TwiggError } from "../errors.js";
import { ResponseStream, type StreamOptions } from "../streaming/response-stream.js";
import type { TwiggWarning } from "../streaming/result.js";
import { type RunToolsRequest, ToolRunner } from "../tools/runner.js";
import type {
  AbortAccepted,
  ChatId,
  CreateResponseRequest,
  ExternalChatId,
  OpenChatRequest,
  RunId,
} from "../types.js";
import { type ChatRef, type Chats, chatPath } from "./chats.js";
import type { Runs } from "./runs.js";

/**
 * A submission. `idempotency_key` is generated when absent, and `model` falls back to the
 * client's default model. The SDK always streams, so `stream` is not offered; `chat` only applies
 * to a chat addressed by external id, so it is in {@link ExternalResponseRequest}.
 */
export type ResponseRequest = Omit<
  CreateResponseRequest,
  "idempotency_key" | "model" | "stream" | "chat"
> & {
  idempotency_key?: string | null;
  model?: string;
};

/** A submission to a chat addressed by external id, which is created on first use. */
export type ExternalResponseRequest = ResponseRequest & {
  /**
   * How to create the chat if no chat holds the external id yet. On an existing chat it is
   * ignored, except that a `namespace` differing from the chat's is refused with 409
   * `external_id_namespace_mismatch`.
   */
  chat?: OpenChatRequest | null;
};

export interface ResponsesDeps {
  runs: Runs;
  chats: Chats;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onWarning: ((warning: TwiggWarning) => void) | undefined;
  maxRetries: number;
  /** The client's default model, for requests that name none. */
  model: string | undefined;
}

export class Responses extends Resource {
  constructor(
    transport: Transport,
    private readonly deps: ResponsesDeps,
  ) {
    super(transport);
  }

  /**
   * Submit a prompt or tool results and stream the model's answer. Nothing is sent until the
   * stream is iterated, awaited with `final()`, or asked for its `runId`.
   *
   * Each submission carries an idempotency key, generated when absent. If the connection drops,
   * the turn carries on server-side and `final()` recovers its result from the run and history.
   */
  create(chatId: ChatId, body: ResponseRequest, options?: StreamOptions): ResponseStream {
    return this.createAt(chatId, body, options);
  }

  /**
   * Submit to the chat holding `externalId`, creating it on first use, and stream the answer.
   * One request, however new the chat; `body.chat` says how to create it. Recovery and abort
   * also address the chat by its external id.
   */
  createByExternalId(
    externalId: ExternalChatId,
    body: ExternalResponseRequest,
    options?: StreamOptions,
  ): ResponseStream {
    return this.createAt({ externalId }, body, options);
  }

  /** @internal */
  createAt(chat: ChatRef, body: ExternalResponseRequest, options?: StreamOptions): ResponseStream {
    const model = body.model ?? this.deps.model;
    if (!model)
      throw new TwiggError(
        "No model. Pass `model` with the request, in the chat's defaults, or to new Twigg().",
        { code: "missing_model" },
      );
    return new ResponseStream(
      {
        ...this.deps,
        transport: this.transport,
        abortRun: (ref, runId) => this.abortAt(ref, { run_id: runId }),
      },
      chat,
      { ...body, model } as CreateResponseRequest,
      options,
    );
  }

  /**
   * Run the tool loop: stream a turn, run the tools it calls, submit their results, and repeat
   * until the model answers without calling more. Await `final()` for the outcome, or iterate
   * for every turn's events and every tool result submitted.
   */
  runTools(chatId: ChatId, request: RunToolsRequest, options?: StreamOptions): ToolRunner {
    return new ToolRunner(this, chatId, request, options);
  }

  /** `runTools` for the chat holding `externalId`, creating it on the first turn. */
  runToolsByExternalId(
    externalId: ExternalChatId,
    request: RunToolsRequest & { chat?: OpenChatRequest | null },
    options?: StreamOptions,
  ): ToolRunner {
    return new ToolRunner(this, { externalId }, request, options);
  }

  /**
   * Retry the chat's latest failed run without adding input. Pass the model and any
   * request-level tools again; the retry uses the current configuration.
   */
  retry(
    chatId: ChatId,
    runId: RunId,
    body: Omit<ResponseRequest, "input" | "retry_of" | "idempotency_key">,
    options?: StreamOptions,
  ): ResponseStream {
    return this.createAt(chatId, { ...body, input: [], retry_of: runId }, options);
  }

  /** `retry` for the chat holding `externalId`. */
  retryByExternalId(
    externalId: ExternalChatId,
    runId: RunId,
    body: Omit<ResponseRequest, "input" | "retry_of" | "idempotency_key">,
    options?: StreamOptions,
  ): ResponseStream {
    return this.createAt({ externalId }, { ...body, input: [], retry_of: runId }, options);
  }

  /**
   * Stop the chat's turn in progress. Pass `run_id` to abort only that run, so a late abort
   * cannot stop a newer turn. The outcome arrives on the stream as `done` with
   * `stop_reason: "aborted"`.
   */
  abort(
    chatId: ChatId,
    query: { run_id?: RunId } = {},
    options?: RequestOptions,
  ): Promise<AbortAccepted> {
    return this.abortAt(chatId, query, options);
  }

  /** `abort` for the chat holding `externalId`. */
  abortByExternalId(
    externalId: ExternalChatId,
    query: { run_id?: RunId } = {},
    options?: RequestOptions,
  ): Promise<AbortAccepted> {
    return this.abortAt({ externalId }, query, options);
  }

  /** @internal */
  abortAt(
    chat: ChatRef,
    query: { run_id?: RunId } = {},
    options?: RequestOptions,
  ): Promise<AbortAccepted> {
    return this.transport.json(
      {
        method: "POST",
        path: `${chatPath(chat)}/abort`,
        query,
        auth: "required",
        idempotent: false,
      },
      options,
    );
  }
}
