import type { RequestOptions } from "../../core/transport.js";
import type {
  ContextBudgetPolicyId,
  ContextBudgetVersion,
  DeactivateResponse,
  ModelId,
  PublishContextBudgetRequest,
} from "../../types.js";
import { ConfigSurface, type ScopeQuery } from "./surface.js";

/** Selects a budget: a scope, and a model id or the scope default when absent. */
export interface BudgetQuery extends ScopeQuery {
  model?: ModelId;
}

/**
 * Context budgets. Each scope has a default budget plus optional per-model ones; budgets do not
 * combine across scopes, the nearest one wins.
 */
export class Budgets extends ConfigSurface {
  protected readonly base = "/api/v1/config/budgets";

  /**
   * Publish one budget document for each of `model_ids`, or the scope default when the list is
   * empty or absent. Returns one new version per model.
   */
  publish(
    body: PublishContextBudgetRequest,
    options?: RequestOptions,
  ): Promise<ContextBudgetVersion[]> {
    return this.publishTo(body, options);
  }

  /** The active budgets in exactly this scope, with their documents. */
  active(query: ScopeQuery = {}, options?: RequestOptions): Promise<ContextBudgetVersion[]> {
    return this.getAt("", { ...query }, options);
  }

  /** Every version in exactly this scope, optionally for one model. */
  versions(query: BudgetQuery = {}, options?: RequestOptions): Promise<ContextBudgetVersion[]> {
    return this.getAt("/versions", { ...query }, options);
  }

  restore(id: ContextBudgetPolicyId, options?: RequestOptions): Promise<ContextBudgetVersion> {
    return this.restoreAt(id, options);
  }

  withdraw(query: BudgetQuery = {}, options?: RequestOptions): Promise<DeactivateResponse> {
    return this.withdrawAt({ ...query }, options);
  }
}
