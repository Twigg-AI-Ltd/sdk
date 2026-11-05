import { Resource } from "../../core/resource.js";
import type { RequestOptions, Transport } from "../../core/transport.js";
import type {
  ConfigDeletion,
  DefaultPolicies,
  Namespace,
  ResolvedBudget,
  ResolvedConfig,
} from "../../types.js";
import { type BudgetQuery, Budgets } from "./budgets.js";
import { Instructions } from "./instructions.js";
import { Retention } from "./retention.js";
import type { ScopeQuery } from "./surface.js";
import { Tools } from "./tools.js";

export class Config extends Resource {
  readonly instructions: Instructions;
  readonly tools: Tools;
  readonly budgets: Budgets;
  readonly retention: Retention;

  constructor(transport: Transport) {
    super(transport);
    this.instructions = new Instructions(transport);
    this.tools = new Tools(transport);
    this.budgets = new Budgets(transport);
    this.retention = new Retention(transport);
  }

  /** The effective instructions, tools and retention for a scope, after inheritance. */
  resolve(query: ScopeQuery = {}, options?: RequestOptions): Promise<ResolvedConfig> {
    return this.get("/resolved", { ...query }, options);
  }

  /** The budget a model would run under in a scope, and where it came from. */
  resolveBudget(query: BudgetQuery = {}, options?: RequestOptions): Promise<ResolvedBudget> {
    return this.get("/resolved-budget", { ...query }, options);
  }

  /** The platform defaults used when no scope has published a budget or retention policy. */
  defaults(options?: RequestOptions): Promise<DefaultPolicies> {
    return this.get("/defaults", {}, options);
  }

  /** Every namespace with configuration or chats. */
  namespaces(options?: RequestOptions): Promise<Namespace[]> {
    return this.get("/namespaces", {}, options);
  }

  /**
   * Permanently delete every instruction, tool, retention and budget version, active or not, in
   * `namespacePrefix` and every namespace beneath it, by path segment. Organisation-wide
   * configuration is never touched, and chats there keep working under what their ancestors
   * still configure. Unlike `withdraw` this cannot be undone: the deleted version ids answer 404
   * afterwards, including from runs that used them. Returns how many versions were deleted.
   */
  delete(namespacePrefix: Namespace, options?: RequestOptions): Promise<ConfigDeletion> {
    return this.transport.json(
      {
        method: "DELETE",
        path: "/api/v1/config",
        query: { namespace_prefix: namespacePrefix },
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }

  private get<T>(
    suffix: string,
    query: Record<string, string | undefined>,
    options?: RequestOptions,
  ): Promise<T> {
    return this.transport.json(
      {
        method: "GET",
        path: `/api/v1/config${suffix}`,
        query,
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }
}

export type { BudgetQuery } from "./budgets.js";
export type { ScopeQuery } from "./surface.js";
export { Budgets, Instructions, Retention, Tools };
