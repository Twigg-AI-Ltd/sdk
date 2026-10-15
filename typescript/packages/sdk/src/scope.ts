// A client view pinned to one namespace, so multi-tenant code cannot forget the scope.
import type { Chat, ChatDefaults } from "./chat.js";
import type { PagePromise } from "./core/pagination.js";
import type { RequestOptions } from "./core/transport.js";
import type { Chats } from "./resources/chats.js";
import type { Config } from "./resources/config/index.js";
import type { UsageResource } from "./resources/usage.js";
import type {
  ChatCreated,
  ChatSummary,
  ConfigVersion,
  ContextBudgetVersion,
  CreateChatRequest,
  DeactivateResponse,
  ListChatsQuery,
  ModelId,
  PublishContextBudgetRequest,
  PublishInstructionRequest,
  PublishRetentionPolicyRequest,
  PublishToolsRequest,
  ResolvedBudget,
  ResolvedConfig,
  RetentionPolicyVersion,
  UsageDimension,
  UsageQuery,
  UsageReport,
} from "./types.js";

type WithoutNamespace<T> = Omit<T, "namespace">;

export interface ScopeDeps {
  chats: Chats;
  config: Config;
  usage: UsageResource;
  open: (
    body: CreateChatRequest,
    defaults?: ChatDefaults,
    options?: RequestOptions,
  ) => Promise<Chat>;
}

export class NamespaceScope {
  readonly chats: {
    create(
      body?: WithoutNamespace<CreateChatRequest>,
      options?: RequestOptions,
    ): Promise<ChatCreated>;
    open(
      body?: WithoutNamespace<CreateChatRequest>,
      defaults?: ChatDefaults,
      options?: RequestOptions,
    ): Promise<Chat>;
    /** Chats in this namespace and everything beneath it. */
    list(
      query?: WithoutNamespace<ListChatsQuery>,
      options?: RequestOptions,
    ): PagePromise<ChatSummary>;
  };
  readonly config: {
    instructions: {
      publish(
        body: WithoutNamespace<PublishInstructionRequest>,
        options?: RequestOptions,
      ): Promise<ConfigVersion>;
      versions(options?: RequestOptions): Promise<ConfigVersion[]>;
      withdraw(options?: RequestOptions): Promise<DeactivateResponse>;
    };
    tools: {
      publish(
        body: WithoutNamespace<PublishToolsRequest>,
        options?: RequestOptions,
      ): Promise<ConfigVersion>;
      versions(options?: RequestOptions): Promise<ConfigVersion[]>;
      withdraw(options?: RequestOptions): Promise<DeactivateResponse>;
    };
    budgets: {
      publish(
        body: WithoutNamespace<PublishContextBudgetRequest>,
        options?: RequestOptions,
      ): Promise<ContextBudgetVersion[]>;
      active(options?: RequestOptions): Promise<ContextBudgetVersion[]>;
      versions(
        query?: { model?: ModelId },
        options?: RequestOptions,
      ): Promise<ContextBudgetVersion[]>;
      withdraw(query?: { model?: ModelId }, options?: RequestOptions): Promise<DeactivateResponse>;
    };
    retention: {
      publish(
        body: WithoutNamespace<PublishRetentionPolicyRequest>,
        options?: RequestOptions,
      ): Promise<RetentionPolicyVersion>;
      versions(options?: RequestOptions): Promise<RetentionPolicyVersion[]>;
      withdraw(options?: RequestOptions): Promise<DeactivateResponse>;
    };
    /** The effective configuration here, after inheritance. */
    resolve(options?: RequestOptions): Promise<ResolvedConfig>;
    resolveBudget(query?: { model?: ModelId }, options?: RequestOptions): Promise<ResolvedBudget>;
  };
  readonly usage: {
    /** Usage for this namespace and everything beneath it. */
    query<D extends UsageDimension | undefined = undefined>(
      query: WithoutNamespace<UsageQuery> & { group_by?: D },
      options?: RequestOptions,
    ): Promise<UsageReport<D>>;
  };

  constructor(
    private readonly deps: ScopeDeps,
    readonly namespace: string,
  ) {
    const ns = { namespace };
    const { chats, config, usage } = deps;
    this.chats = {
      create: (body = {}, options) => chats.create(pin(body, namespace), options),
      open: (body = {}, defaults, options) => deps.open(pin(body, namespace), defaults, options),
      list: (query = {}, options) => chats.list(pin(query, namespace), options),
    };
    this.config = {
      instructions: {
        publish: (body, options) => config.instructions.publish(pin(body, namespace), options),
        versions: (options) => config.instructions.versions(ns, options),
        withdraw: (options) => config.instructions.withdraw(ns, options),
      },
      tools: {
        publish: (body, options) => config.tools.publish(pin(body, namespace), options),
        versions: (options) => config.tools.versions(ns, options),
        withdraw: (options) => config.tools.withdraw(ns, options),
      },
      budgets: {
        publish: (body, options) => config.budgets.publish(pin(body, namespace), options),
        active: (options) => config.budgets.active(ns, options),
        versions: (query = {}, options) => config.budgets.versions({ ...query, ...ns }, options),
        withdraw: (query = {}, options) => config.budgets.withdraw({ ...query, ...ns }, options),
      },
      retention: {
        publish: (body, options) => config.retention.publish(pin(body, namespace), options),
        versions: (options) => config.retention.versions(ns, options),
        withdraw: (options) => config.retention.withdraw(ns, options),
      },
      resolve: (options) => config.resolve(ns, options),
      resolveBudget: (query = {}, options) => config.resolveBudget({ ...query, ...ns }, options),
    };
    // Cast: TypeScript cannot match the two generic signatures, though they agree.
    const query = (q: WithoutNamespace<UsageQuery>, options?: RequestOptions) =>
      usage.query(pin(q, namespace), options);
    this.usage = { query: query as NamespaceScope["usage"]["query"] };
  }

  /** A scope for a namespace beneath this one: `acme` then `support` is `acme/support`. */
  child(name: string): NamespaceScope {
    return new NamespaceScope(this.deps, `${this.namespace}/${name}`);
  }
}

/** Add the namespace, refusing a body that names a different one. */
function pin<T extends object>(body: T, namespace: string): T & { namespace: string } {
  const given = (body as { namespace?: unknown }).namespace;
  if (given !== undefined && given !== null && given !== namespace)
    throw new TypeError(`This scope is pinned to ${namespace}, not ${String(given)}`);
  return { ...body, namespace };
}
