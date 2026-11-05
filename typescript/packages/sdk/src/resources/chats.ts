import type { Chat, ChatDefaults } from "../chat.js";
import { DirectionalPage } from "../core/directional-page.js";
import { PagePromise } from "../core/pagination.js";
import { Resource } from "../core/resource.js";
import { path, type RequestOptions } from "../core/transport.js";
import type {
  ChatCreated,
  ChatId,
  ChatPage,
  ChatSummary,
  ChatsDeleted,
  CreateChatRequest,
  ExternalChatId,
  GetChatQuery,
  HistoryPageResponse,
  HistoryPart,
  HistoryQuery,
  ImportChatRequest,
  ImportResult,
  ListChatsQuery,
  ListRunsQuery,
  Namespace,
  OpenChatRequest,
  RunPage,
  RunSummary,
  UpdateChatRequest,
} from "../types.js";

/**
 * @internal A chat, by Twigg's id or by the caller's external id. Every chat route has a twin
 * under `/api/v1/chats/external/{external_id}`, so either reaches the same operations.
 */
export type ChatRef = ChatId | { externalId: ExternalChatId };

/** @internal The path prefix of a chat's routes. */
export function chatPath(chat: ChatRef): string {
  return typeof chat === "string"
    ? path`/api/v1/chats/${chat}`
    : path`/api/v1/chats/external/${chat.externalId}`;
}

export type HistoryPage = DirectionalPage<HistoryPart> & {
  /** Ordinal of the first part in `data`; `null` when the page is empty. */
  readonly firstOrdinal: number | null;
  /** Ordinal of the last part in `data`; `null` when the page is empty. */
  readonly lastOrdinal: number | null;
};

type IdCursors = { after_id?: string | null; before_id?: string | null };

/**
 * Page a listing whose items come newest first and whose cursors are ids: `last_id` pages older,
 * `first_id` newer. Iteration follows the direction the first query chose.
 */
function byId<T, Q extends IdCursors>(
  query: Q,
  fetch: (query: Q) => Promise<{
    data: T[];
    has_more: boolean;
    first_id?: string | null;
    last_id?: string | null;
  }>,
): PagePromise<T> {
  const newer = query.before_id !== undefined && query.before_id !== null;
  const load = async (q: Q): Promise<DirectionalPage<T>> => {
    const page = await fetch(q);
    const cursor = newer ? page.first_id : page.last_id;
    const next =
      cursor === null || cursor === undefined
        ? undefined
        : () =>
            load(
              newer
                ? { ...q, before_id: cursor, after_id: undefined }
                : { ...q, after_id: cursor, before_id: undefined },
            );
    return new DirectionalPage(page.data, page.has_more, next, newer);
  };
  return new PagePromise(() => load(query));
}

export class Chats extends Resource {
  /** @internal Set by the client so `open` can return a chat handle. */
  handle:
    | ((id: ChatId, defaults: ChatDefaults, data: ChatCreated | ChatSummary) => Chat)
    | undefined;

  /** Create a chat and return a handle on it, with request defaults for its turns. */
  async open(
    body: CreateChatRequest = {},
    defaults: ChatDefaults = {},
    options?: RequestOptions,
  ): Promise<Chat> {
    const created = await this.create(body, options);
    if (!this.handle) throw new Error("Chats.open needs a client");
    return this.handle(created.id, defaults, created);
  }

  /** Open a chat. Every field is optional; the namespace is immutable once set. */
  create(body: CreateChatRequest = {}, options?: RequestOptions): Promise<ChatCreated> {
    return this.transport.json(
      { method: "POST", path: "/api/v1/chats", body, auth: "required", idempotent: false },
      options,
    );
  }

  /**
   * Return a handle on the chat holding `externalId`, your own identifier for it such as a phone
   * number, creating the chat from `body` if there is none. On an existing chat `body` is
   * ignored, except that a `namespace` that differs from the chat's is refused with 409
   * `external_id_namespace_mismatch`.
   */
  async openByExternalId(
    externalId: ExternalChatId,
    body: OpenChatRequest = {},
    defaults: ChatDefaults = {},
    options?: RequestOptions,
  ): Promise<Chat> {
    const chat = await this.transport.json<ChatSummary>(
      {
        method: "PUT",
        path: path`/api/v1/chats/external/${externalId}`,
        body,
        auth: "required",
        idempotent: true,
      },
      options,
    );
    if (!this.handle) throw new Error("Chats.openByExternalId needs a client");
    return this.handle(chat.id, defaults, chat);
  }

  /**
   * The chat holding `externalId`. Unknown and deleted ids are a 404. `{ include: "usage" }` adds
   * the chat's cost and token totals as `usage`.
   */
  getByExternalId(
    externalId: ExternalChatId,
    query: GetChatQuery = {},
    options?: RequestOptions,
  ): Promise<ChatSummary> {
    return this.getAt({ externalId }, query, options);
  }

  /** Change the chat holding `externalId`; see `update`. Its external id cannot be changed. */
  updateByExternalId(
    externalId: ExternalChatId,
    body: UpdateChatRequest,
    options?: RequestOptions,
  ): Promise<ChatSummary> {
    return this.updateAt({ externalId }, body, options);
  }

  /** The runs on the chat holding `externalId`; see `runs`. */
  runsByExternalId(
    externalId: ExternalChatId,
    query: ListRunsQuery = {},
    options?: RequestOptions,
  ): PagePromise<RunSummary> {
    return this.runsAt({ externalId }, query, options);
  }

  /** Delete the chat holding `externalId`. The id is freed for a new chat. */
  deleteByExternalId(externalId: ExternalChatId, options?: RequestOptions): Promise<void> {
    return this.deleteAt({ externalId }, options);
  }

  /** Read the chat holding `externalId`'s parts; see `history`. */
  historyByExternalId(
    externalId: ExternalChatId,
    query: HistoryQuery = {},
    options?: RequestOptions,
  ): PagePromise<HistoryPart, HistoryPage> {
    return this.historyAt({ externalId }, query, options);
  }

  /**
   * Store an existing conversation as the history of the chat holding `externalId`, creating the
   * chat from `body.chat` if there is none. Only an empty chat is written to: one that already has
   * history answers `skipped: true` and nothing is stored or charged, so a retry is safe. The
   * API repairs the parts into a valid conversation and lists every change in `warnings`.
   * At most 500 parts; charged per million estimated tokens stored.
   */
  importByExternalId(
    externalId: ExternalChatId,
    body: ImportChatRequest,
    options?: RequestOptions,
  ): Promise<ImportResult> {
    return this.transport.json(
      {
        method: "POST",
        path: path`/api/v1/chats/external/${externalId}/import`,
        body,
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }

  /**
   * A chat owned by your organisation; another's, or a missing one, is a 404.
   * `{ include: "usage" }` adds the chat's cost and token totals as `usage`.
   */
  get(chatId: ChatId, query: GetChatQuery = {}, options?: RequestOptions): Promise<ChatSummary> {
    return this.getAt(chatId, query, options);
  }

  /**
   * Delete a chat and its history. A turn in progress is aborted, and the content is
   * unrecoverable once this returns. Usage and cost records are kept, so `runs.get` still answers.
   */
  delete(chatId: ChatId, options?: RequestOptions): Promise<void> {
    return this.deleteAt(chatId, options);
  }

  /**
   * Change a chat's `title`, `description` or `user_metadata`; fields left out are unchanged. A
   * title or description sent as `null` or `""` is removed. `user_metadata` is merged one
   * top-level key at a time: keys sent replace the stored ones and keys sent as `null` are
   * removed. The namespace and external id cannot be changed. Returns the updated chat.
   */
  update(chatId: ChatId, body: UpdateChatRequest, options?: RequestOptions): Promise<ChatSummary> {
    return this.updateAt(chatId, body, options);
  }

  /**
   * List a chat's runs, newest first: your turns and the compaction runs Twigg made for the chat,
   * with status, model, usage, cost and timing. The context manifest is left out; `runs.get` has
   * it.
   *
   * Iterating walks towards older runs by default. Passing `before_id` pages towards newer runs
   * instead, and iteration then yields them oldest first.
   */
  runs(
    chatId: ChatId,
    query: ListRunsQuery = {},
    options?: RequestOptions,
  ): PagePromise<RunSummary> {
    return this.runsAt(chatId, query, options);
  }

  /**
   * Delete every chat in `namespacePrefix` and every namespace beneath it, by path segment:
   * `swarm/run-abc` covers `swarm/run-abc/agent-17` but not `swarm/run-abcd`. Each is deleted as
   * `delete` deletes one. Returns how many live chats were deleted. Pair it with `config.delete`
   * to remove the subtree's configuration too.
   */
  deleteByNamespace(namespacePrefix: Namespace, options?: RequestOptions): Promise<ChatsDeleted> {
    return this.transport.json(
      {
        method: "DELETE",
        path: "/api/v1/chats",
        query: { namespace_prefix: namespacePrefix },
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }

  /** @internal */
  getAt(chat: ChatRef, query: GetChatQuery = {}, options?: RequestOptions): Promise<ChatSummary> {
    return this.transport.json(
      { method: "GET", path: chatPath(chat), query, auth: "required", idempotent: true },
      options,
    );
  }

  /** @internal */
  updateAt(chat: ChatRef, body: UpdateChatRequest, options?: RequestOptions): Promise<ChatSummary> {
    // A merge: sending the same change again leaves the chat as the first left it.
    return this.transport.json(
      { method: "PATCH", path: chatPath(chat), body, auth: "required", idempotent: true },
      options,
    );
  }

  /** @internal */
  runsAt(
    chat: ChatRef,
    query: ListRunsQuery = {},
    options?: RequestOptions,
  ): PagePromise<RunSummary> {
    return byId<RunSummary, ListRunsQuery>(query, (q) =>
      this.transport.json<RunPage>(
        {
          method: "GET",
          path: `${chatPath(chat)}/runs`,
          query: q,
          auth: "required",
          idempotent: true,
        },
        options,
      ),
    );
  }

  /** @internal */
  deleteAt(chat: ChatRef, options?: RequestOptions): Promise<void> {
    return this.transport.empty(
      { method: "DELETE", path: chatPath(chat), auth: "required", idempotent: true },
      options,
    );
  }

  /**
   * List chats, newest first. A `namespace` includes everything beneath it.
   *
   * Iterating walks towards older chats by default. Passing `before_id` pages towards newer
   * chats instead, and iteration then yields them oldest first.
   */
  list(query: ListChatsQuery = {}, options?: RequestOptions): PagePromise<ChatSummary> {
    return byId<ChatSummary, ListChatsQuery>(query, (q) =>
      this.transport.json<ChatPage>(
        { method: "GET", path: "/api/v1/chats", query: q, auth: "required", idempotent: true },
        options,
      ),
    );
  }

  /**
   * Read a chat's parts. Each page holds parts oldest first; with no cursor it is the newest
   * page.
   *
   * Iterating walks backwards from there, yielding parts newest first, which is what a transcript
   * view loading upwards wants. Passing `after_ordinal` pages forwards instead and yields parts
   * oldest first: what a view already open sends to pick up new parts.
   */
  history(
    chatId: ChatId,
    query: HistoryQuery = {},
    options?: RequestOptions,
  ): PagePromise<HistoryPart, HistoryPage> {
    return this.historyAt(chatId, query, options);
  }

  /** @internal */
  historyAt(
    chat: ChatRef,
    query: HistoryQuery = {},
    options?: RequestOptions,
  ): PagePromise<HistoryPart, HistoryPage> {
    const forward = query.after_ordinal !== undefined && query.after_ordinal !== null;
    const load = async (q: HistoryQuery): Promise<HistoryPage> => {
      const page = await this.transport.json<HistoryPageResponse>(
        {
          method: "GET",
          path: `${chatPath(chat)}/history`,
          query: q,
          auth: "required",
          idempotent: true,
        },
        options,
      );
      const cursor = forward ? page.last_ordinal : page.first_ordinal;
      const next =
        cursor === null || cursor === undefined
          ? undefined
          : () =>
              load(
                forward
                  ? { ...q, after_ordinal: cursor, before_ordinal: undefined }
                  : { ...q, before_ordinal: cursor, after_ordinal: undefined },
              );
      return Object.assign(new DirectionalPage(page.data, page.has_more, next, !forward), {
        firstOrdinal: page.first_ordinal ?? null,
        lastOrdinal: page.last_ordinal ?? null,
      });
    };
    return new PagePromise(() => load(query));
  }
}
