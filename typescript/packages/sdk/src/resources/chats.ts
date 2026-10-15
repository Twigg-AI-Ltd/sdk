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
  CreateChatRequest,
  HistoryPageResponse,
  HistoryPart,
  HistoryQuery,
  ListChatsQuery,
} from "../types.js";

export type HistoryPage = DirectionalPage<HistoryPart> & {
  /** Ordinal of the first part in `data`; `null` when the page is empty. */
  readonly firstOrdinal: number | null;
  /** Ordinal of the last part in `data`; `null` when the page is empty. */
  readonly lastOrdinal: number | null;
};

export class Chats extends Resource {
  /** @internal Set by the client so `open` can return a chat handle. */
  handle: ((id: ChatId, defaults: ChatDefaults, data: ChatCreated) => Chat) | undefined;

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

  get(chatId: ChatId, options?: RequestOptions): Promise<ChatSummary> {
    return this.transport.json(
      { method: "GET", path: path`/api/v1/chats/${chatId}`, auth: "required", idempotent: true },
      options,
    );
  }

  delete(chatId: ChatId, options?: RequestOptions): Promise<void> {
    return this.transport.empty(
      { method: "DELETE", path: path`/api/v1/chats/${chatId}`, auth: "required", idempotent: true },
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
    const newer = query.before_id !== undefined && query.before_id !== null;
    const load = async (q: ListChatsQuery): Promise<DirectionalPage<ChatSummary>> => {
      const page = await this.transport.json<ChatPage>(
        { method: "GET", path: "/api/v1/chats", query: q, auth: "required", idempotent: true },
        options,
      );
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
    const forward = query.after_ordinal !== undefined && query.after_ordinal !== null;
    const load = async (q: HistoryQuery): Promise<HistoryPage> => {
      const page = await this.transport.json<HistoryPageResponse>(
        {
          method: "GET",
          path: path`/api/v1/chats/${chatId}/history`,
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
