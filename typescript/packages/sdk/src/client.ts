import { Chat, type ChatDefaults } from "./chat.js";
import { type RequestOptions, sleep, Transport } from "./core/transport.js";
import { CatalogueResource } from "./resources/catalogue.js";
import { Chats } from "./resources/chats.js";
import { Config } from "./resources/config/index.js";
import { Meta } from "./resources/meta.js";
import { Models } from "./resources/models.js";
import { Namespaces } from "./resources/namespaces.js";
import { Responses } from "./resources/responses.js";
import { Runs } from "./resources/runs.js";
import { UsageResource } from "./resources/usage.js";
import { NamespaceScope } from "./scope.js";
import type { TwiggWarning } from "./streaming/result.js";
import type { ChatCreated, ChatSummary } from "./types.js";

export interface ClientOptions {
  /** Defaults to the `TWIGG_API_KEY` environment variable. Only the public calls work without. */
  apiKey?: string;
  /** Defaults to `TWIGG_BASE_URL`, then `https://api.twigg.ai`. */
  baseURL?: string;
  /** Milliseconds per attempt. Default 60 000. */
  timeout?: number;
  /** Retries for failures that are safe to repeat. Default 2. */
  maxRetries?: number;
  /** A fetch implementation, for tests or runtimes without a global one. */
  fetch?: typeof fetch;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * The model for turns that name none: used by `chat.send`, `responses.create` and the tool
   * loop unless the call or the chat's defaults set `model`.
   */
  model?: string;
  /** Called with every configuration or translation warning any stream reports. */
  onWarning?: (warning: TwiggWarning) => void;
  /** @internal The wait between retries; replaced in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_BASE_URL = "https://api.twigg.ai";

export class Twigg {
  readonly chats: Chats;
  readonly responses: Responses;
  readonly runs: Runs;
  readonly models: Models;
  readonly namespaces: Namespaces;
  readonly usage: UsageResource;
  readonly catalogue: CatalogueResource;
  readonly config: Config;
  readonly meta: Meta;

  constructor(options: ClientOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("No fetch available. Pass one as the `fetch` option.");
    const maxRetries = options.maxRetries ?? 2;
    const pause = options.sleep ?? sleep;
    const transport = new Transport({
      apiKey: options.apiKey ?? env("TWIGG_API_KEY"),
      baseURL: options.baseURL ?? env("TWIGG_BASE_URL") ?? DEFAULT_BASE_URL,
      timeout: options.timeout ?? 60_000,
      maxRetries,
      fetch: fetchImpl,
      sleep: pause,
      headers: options.headers ?? {},
    });
    this.chats = new Chats(transport);
    this.runs = new Runs(transport);
    this.responses = new Responses(transport, {
      runs: this.runs,
      chats: this.chats,
      sleep: pause,
      onWarning: options.onWarning,
      maxRetries,
      model: options.model,
    });
    this.models = new Models(transport);
    this.namespaces = new Namespaces(transport);
    this.usage = new UsageResource(transport);
    this.catalogue = new CatalogueResource(transport);
    this.config = new Config(transport);
    this.meta = new Meta(transport);
    this.chats.handle = (id, defaults, data) => this.chat(id, defaults, data);
  }

  /**
   * A handle on an existing chat, from its id or from a record `chats.list()` or `chats.get()`
   * returned (kept as `chat.data`). `defaults` fill request fields such as `model`.
   *
   *   for await (const summary of twigg.chats.list({ namespace })) twigg.chat(summary)
   */
  chat(
    chat: string | ChatSummary | ChatCreated,
    defaults: ChatDefaults = {},
    data?: ChatCreated,
  ): Chat {
    if (typeof chat === "string") return new Chat(this.chats, this.responses, chat, defaults, data);
    return new Chat(this.chats, this.responses, chat.id, defaults, chat);
  }

  /** A view of the client pinned to one namespace. */
  namespace(namespace: string): NamespaceScope {
    return new NamespaceScope(
      {
        chats: this.chats,
        config: this.config,
        usage: this.usage,
        open: (body, defaults, options) => this.chats.open(body, defaults, options),
      },
      namespace,
    );
  }
}

/** Read an environment variable where there is one: Node, Bun and Deno have `process.env`. */
function env(name: string): string | undefined {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env?.[name] || undefined;
}

export type { RequestOptions };
