// A Twigg client backed by an in-memory server: chats, history, runs and scripted turns behave
// like the real API, so code under test runs through the real SDK without a network or credits.
import { type ClientOptions, Twigg } from "../client.js";
import type {
  CatalogueModel,
  ChatSummary,
  CreateChatRequest,
  CreateResponseRequest,
  HistoryBody,
  HistoryPart,
  ImportChatRequest,
  OpenChatRequest,
  ResponseEvent,
  RunInspection,
} from "../types.js";
import { fakeId, type StreamBuilder, sseResponse } from "./stream-builder.js";

/** What a scripted turn sees: the chat, the request, and the chat's history so far. */
export interface TurnContext {
  chatId: string;
  request: CreateResponseRequest;
  history: HistoryPart[];
}

/** A turn's script: a built stream, or a function choosing one from the request. */
export type ScriptedTurn =
  | StreamBuilder
  | ((context: TurnContext) => StreamBuilder | Promise<StreamBuilder>);

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface MockOptions extends Omit<ClientOptions, "fetch" | "apiKey" | "baseURL"> {
  /** Turns to answer `responses.create` with, in order. */
  turns?: ScriptedTurn[];
  /** What `models.list()` returns. */
  models?: CatalogueModel[];
}

export class MockTwigg extends Twigg {
  readonly server: MockServer;

  constructor(options: MockOptions = {}) {
    const server = new MockServer(options.turns ?? [], options.models ?? []);
    super({
      ...options,
      apiKey: "tw_mock",
      baseURL: "https://mock.twigg.invalid",
      fetch: server.fetch,
      sleep: options.sleep ?? (async () => {}),
    });
    this.server = server;
  }

  /** Queue more scripted turns. */
  respond(...turns: ScriptedTurn[]): this {
    this.server.turns.push(...turns);
    return this;
  }
}

interface StoredChat extends ChatSummary {
  namespace: string | null;
}

export class MockServer {
  readonly chats = new Map<string, StoredChat>();
  readonly parts = new Map<string, HistoryPart[]>();
  readonly runs = new Map<string, RunInspection>();
  /** Every request the client made, in order. */
  readonly calls: RecordedCall[] = [];
  private readonly keys = new Map<string, string>();
  private ordinal = 0;
  private clock = Date.parse("2026-01-01T00:00:00Z");

  constructor(
    readonly turns: ScriptedTurn[],
    readonly models: CatalogueModel[],
  ) {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ method, path: url.pathname, query, body });
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      return await this.route(method, segments, query, body);
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  };

  private async route(
    method: string,
    s: string[],
    query: Record<string, string>,
    body: unknown,
  ): Promise<Response> {
    const [api, v1, resource, id, sub] = s;
    if (api !== "api" || v1 !== "v1") return notMocked(method, s);
    if (resource === "models" && method === "GET") return json(this.models);
    if (resource === "runs" && id && method === "GET") return json(this.run(id));
    if (resource !== "chats") return notMocked(method, s);
    if (id === "external" && sub && s.length <= 6) return this.external(method, s, query, body);
    if (!id) {
      if (method === "POST") return json(this.createChat(body as CreateChatRequest), 201);
      if (method === "GET") return json(this.listChats(query));
    } else if (!sub) {
      const chat = this.chat(id);
      if (method === "GET") return json(chat);
      if (method === "DELETE") {
        this.chats.delete(id);
        this.parts.delete(id);
        return new Response(null, { status: 204 });
      }
    } else if (sub === "history" && method === "GET") return json(this.history(id, query));
    else if (sub === "responses" && method === "POST")
      return this.respond(id, body as CreateResponseRequest);
    else if (sub === "abort" && method === "POST")
      return error(
        409,
        "no_active_turn",
        "this chat has no turn in progress; it may already have finished",
      );
    return notMocked(method, s);
  }

  /** A route under `/chats/external/{external_id}`: the by-id route for the chat holding it. */
  private external(
    method: string,
    s: string[],
    query: Record<string, string>,
    body: unknown,
  ): Promise<Response> {
    const [, , , , externalId = "", sub] = s;
    const held = [...this.chats.values()].find((c) => c.external_id === externalId);
    if (method === "POST" && sub === "import")
      return Promise.resolve(this.importChat(externalId, held, body as ImportChatRequest));
    // Opening, and a turn's submission, create the chat on first use.
    const open =
      method === "PUT" && !sub
        ? ((body ?? {}) as OpenChatRequest)
        : method === "POST" && sub === "responses"
          ? ((body as { chat?: OpenChatRequest | null }).chat ?? {})
          : undefined;
    if (open && !held) {
      const chat = this.createChat({ ...open, external_id: externalId });
      if (!sub) return Promise.resolve(json(chat, 201));
      return this.route(method, ["api", "v1", "chats", chat.id, sub], query, body);
    }
    if (!held) return Promise.resolve(error(404, "not_found", "not found"));
    if (open && "namespace" in open && (open.namespace ?? null) !== held.namespace)
      return Promise.resolve(
        error(409, "external_id_namespace_mismatch", "the chat has a different namespace"),
      );
    if (method === "PUT" && !sub) return Promise.resolve(json(held));
    return this.route(method, ["api", "v1", "chats", held.id, ...(sub ? [sub] : [])], query, body);
  }

  /**
   * Store the parts as the chat's history, creating the chat if none holds the id. The parts are
   * stored as sent: the mock does not repair them the way the API does, so `warnings` is empty.
   */
  private importChat(
    externalId: string,
    held: StoredChat | undefined,
    request: ImportChatRequest,
  ): Response {
    const open = request.chat ?? {};
    if (held && "namespace" in open && (open.namespace ?? null) !== held.namespace)
      return error(409, "external_id_namespace_mismatch", "the chat has a different namespace");
    const chat = held ?? this.createChat({ ...open, external_id: externalId });
    const existing = this.chatParts(chat.id).length;
    if (existing > 0) return json({ chat_id: chat.id, skipped: true, existing_parts: existing });
    for (const part of request.parts) {
      if (part.type === "prompt") this.append(chat.id, "user", { type: "prompt", text: part.text });
      else if (part.type === "message")
        this.append(chat.id, "assistant", { type: "message", text: part.text });
      else if (part.type === "tool_call")
        this.append(chat.id, "assistant", {
          type: "tool_call",
          tool_use_id: part.tool_use_id,
          tool_name: part.name,
          arguments:
            typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments),
        });
      else
        this.append(chat.id, "user", {
          type: "tool_result",
          tool_use_id: part.tool_use_id,
          tool_name: part.tool_name,
          text: part.text ?? "",
          is_error: part.is_error ?? false,
          trust: "customer_data",
          tombstone_reason: null,
        });
    }
    return json(
      {
        chat_id: chat.id,
        created_chat: !held,
        imported_parts: request.parts.length,
        dropped_parts: 0,
        closed_tool_calls: [],
        estimated_tokens: 0,
        cost: "0",
        cost_currency: "USD",
        warnings: [],
      },
      201,
    );
  }

  private createChat(request: CreateChatRequest): StoredChat {
    if (
      request.external_id &&
      [...this.chats.values()].some((c) => c.external_id === request.external_id)
    )
      throw error(409, "external_id_taken", "another chat holds this external id");
    const chat: StoredChat = {
      id: fakeId(10),
      namespace: request.namespace ?? null,
      external_id: request.external_id ?? null,
      title: request.title ?? null,
      description: request.description ?? null,
      user_metadata: request.user_metadata ?? {},
      created_at: this.now(),
      length: 0,
    } as StoredChat;
    this.chats.set(chat.id, chat);
    this.parts.set(chat.id, []);
    return chat;
  }

  private listChats(query: Record<string, string>) {
    const prefix = query.namespace;
    let all = [...this.chats.values()]
      .filter((c) => !prefix || c.namespace === prefix || c.namespace?.startsWith(`${prefix}/`))
      .reverse();
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
    if (query.after_id) {
      const at = all.findIndex((c) => c.id === query.after_id);
      all = at === -1 ? [] : all.slice(at + 1);
    }
    let page: StoredChat[];
    let hasMore: boolean;
    if (query.before_id) {
      const end = all.findIndex((c) => c.id === query.before_id);
      const newer = all.slice(0, Math.max(end, 0));
      page = newer.slice(-limit);
      hasMore = newer.length > limit;
    } else {
      page = all.slice(0, limit);
      hasMore = all.length > limit;
    }
    return {
      data: page,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
      has_more: hasMore,
    };
  }

  private history(chatId: string, query: Record<string, string>) {
    const parts = this.chatParts(chatId);
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 100);
    let page: HistoryPart[];
    let hasMore: boolean;
    if (query.after_ordinal !== undefined) {
      const newer = parts.filter((p) => p.ordinal > Number(query.after_ordinal));
      page = newer.slice(0, limit);
      hasMore = newer.length > limit;
    } else {
      const older =
        query.before_ordinal === undefined
          ? parts
          : parts.filter((p) => p.ordinal < Number(query.before_ordinal));
      page = older.slice(-limit);
      hasMore = older.length > limit;
    }
    return {
      data: page,
      first_ordinal: page[0]?.ordinal ?? null,
      last_ordinal: page.at(-1)?.ordinal ?? null,
      has_more: hasMore,
    };
  }

  private async respond(chatId: string, request: CreateResponseRequest): Promise<Response> {
    this.chat(chatId);
    const key = request.idempotency_key;
    const used = key ? this.keys.get(key) : undefined;
    if (key && used)
      return error(
        409,
        "conflict",
        `idempotency key '${key}' was already used; it belongs to run ${used}`,
      );
    const turn = this.turns.shift();
    if (!turn)
      return error(
        500,
        "not_mocked",
        "MockTwigg has no scripted turn left; queue one with respond()",
      );

    for (const part of request.input) {
      if (part.type === "prompt")
        this.append(chatId, "user", { type: "prompt", text: part.text ?? "" });
      else
        this.append(chatId, "user", {
          type: "tool_result",
          tool_use_id: part.tool_use_id,
          tool_name: part.tool_name,
          text: part.text ?? "",
          is_error: part.is_error ?? false,
          trust: part.trust ?? "customer_data",
          tombstone_reason: null,
        });
    }
    const builder =
      typeof turn === "function"
        ? await turn({ chatId, request, history: this.chatParts(chatId) })
        : turn;
    const runId = builder.runId;
    if (key) this.keys.set(key, runId);
    const events = builder
      .toEvents()
      .map((e) =>
        e.event === "run" ? { ...e, data: { ...e.data, chat_id: chatId } } : e,
      ) as ResponseEvent[];
    this.record(chatId, runId, request, events);
    return sseResponse(events, builder.dropAfter);
  }

  /** Write the turn's output to history and its run record, as the real API would. */
  private record(
    chatId: string,
    runId: string,
    request: CreateResponseRequest,
    events: ResponseEvent[],
  ) {
    const created = this.now();
    let open: { kind: string; text: string; id?: string; name?: string } | undefined;
    let status: RunInspection["status"] = "running";
    let usage: RunInspection["usage"] = null;
    let cost: string | null = null;
    let failure: string | null = null;
    const close = () => {
      if (!open) return;
      if (open.kind === "text" && open.text)
        this.append(chatId, "assistant", { type: "message", text: open.text });
      if (open.kind === "reasoning" && open.text)
        this.append(chatId, "assistant", { type: "reasoning", text: open.text });
      if (open.kind === "refusal" && open.text)
        this.append(chatId, "assistant", { type: "message", text: "", refusal: open.text });
      if (open.kind === "tool_call")
        this.append(chatId, "assistant", {
          type: "tool_call",
          tool_use_id: open.id ?? "",
          tool_name: open.name ?? "",
          arguments: open.text,
        });
      open = undefined;
    };
    for (const event of events) {
      if (event.event === "block_start") {
        close();
        open =
          event.data.kind === "tool_call"
            ? {
                kind: "tool_call",
                text: "",
                id: event.data.tool_use_id,
                name: event.data.tool_name,
              }
            : { kind: event.data.kind, text: "" };
      } else if (event.event === "delta") {
        // Like the SDK, a delta outside a block of its kind starts one.
        const kind = event.data.kind === "tool_input" ? "tool_call" : event.data.kind;
        if (open?.kind !== kind) {
          close();
          open = { kind, text: "" };
        }
        open.text += event.data.text;
      } else if (event.event === "block_stop") close();
      else if (event.event === "done") {
        close();
        status = event.data.stop_reason === "aborted" ? "cancelled" : "succeeded";
        usage = event.data.usage;
        cost = event.data.cost ?? null;
      } else if (event.event === "error") {
        close();
        status = "failed";
        failure = event.data.message;
      }
    }
    this.runs.set(runId, {
      id: runId,
      chat_id: chatId,
      namespace: this.chats.get(chatId)?.namespace ?? null,
      origin: "customer",
      status,
      is_live: status === "running",
      error: failure,
      model: request.model,
      provider_request_id: null,
      usage,
      latency_ms: null,
      cost,
      settled_at: cost ? created : null,
      manifest: {},
      created_at: created,
      completed_at: status === "running" ? null : this.now(),
    });
  }

  private append(chatId: string, role: "user" | "assistant", part: HistoryBody): void {
    const parts = this.chatParts(chatId);
    parts.push({
      id: fakeId(11),
      ordinal: this.ordinal++,
      created_at: this.now(),
      role,
      part,
      user_metadata: {},
    } as HistoryPart);
    const chat = this.chats.get(chatId);
    if (chat) chat.length = parts.length;
  }

  private chat(id: string): StoredChat {
    const chat = this.chats.get(id);
    if (!chat) throw error(404, "not_found", "not found");
    return chat;
  }

  private chatParts(id: string): HistoryPart[] {
    this.chat(id);
    return this.parts.get(id) ?? [];
  }

  private run(id: string): RunInspection {
    const run = this.runs.get(id);
    if (!run) throw error(404, "not_found", "not found");
    return run;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function notMocked(method: string, segments: string[]): Response {
  return error(501, "not_mocked", `MockTwigg does not implement ${method} /${segments.join("/")}`);
}
