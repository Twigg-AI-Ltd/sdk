import { Resource } from "../../core/resource.js";
import { path, type QueryValue, type RequestOptions } from "../../core/transport.js";
import type { DeactivateResponse } from "../../types.js";

/**
 * What the four configuration surfaces share. Each is versioned per scope: publishing creates a
 * version and activates it, restoring re-activates an older one, and withdrawing removes the
 * scope's override so it inherits from its parent.
 */
export abstract class ConfigSurface extends Resource {
  protected abstract readonly base: string;

  protected publishTo<T>(body: unknown, options?: RequestOptions): Promise<T> {
    // Not retried on failure: a second publish would be a second version.
    return this.transport.json(
      { method: "POST", path: this.base, body, auth: "required", idempotent: false },
      options,
    );
  }

  protected getAt<T>(
    suffix: string,
    query: Record<string, QueryValue>,
    options?: RequestOptions,
  ): Promise<T> {
    return this.transport.json(
      { method: "GET", path: this.base + suffix, query, auth: "required", idempotent: true },
      options,
    );
  }

  protected restoreAt<T>(id: string, options?: RequestOptions): Promise<T> {
    // Activating the version that is already active changes nothing, so this may retry.
    return this.transport.json(
      {
        method: "POST",
        path: this.base + path`/${id}/activate`,
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }

  protected withdrawAt(
    query: Record<string, QueryValue>,
    options?: RequestOptions,
  ): Promise<DeactivateResponse> {
    return this.transport.json(
      {
        method: "DELETE",
        path: `${this.base}/active`,
        query,
        auth: "required",
        idempotent: true,
      },
      options,
    );
  }
}

/** Selects a scope: a namespace, or the organisation-wide scope when absent. */
export interface ScopeQuery {
  namespace?: string;
}
