import { Resource } from "../core/resource.js";
import type { RequestOptions } from "../core/transport.js";
import type { UsageDimension, UsageQuery, UsageReport } from "../types.js";

export class UsageResource extends Resource {
  /**
   * Usage and cost over a window, optionally binned by hour or day and grouped by a dimension.
   * A `namespace` includes everything beneath it. With `group_by`, each row's `group` is typed
   * for that dimension, so `group_by: "model"` gives rows with a `model_name`.
   */
  query<D extends UsageDimension | undefined = undefined>(
    query: UsageQuery & { group_by?: D },
    options?: RequestOptions,
  ): Promise<UsageReport<D>> {
    return this.transport.json(
      { method: "GET", path: "/api/v1/usage", query, auth: "required", idempotent: true },
      options,
    );
  }
}
