import { Resource } from "../core/resource.js";
import type { RequestOptions } from "../core/transport.js";
import type { CatalogueModel } from "../types.js";

export class Models extends Resource {
  /** Models available to this organisation, priced for it. Use `name` as the request `model`. */
  list(options?: RequestOptions): Promise<CatalogueModel[]> {
    return this.transport.json(
      { method: "GET", path: "/api/v1/models", auth: "required", idempotent: true },
      options,
    );
  }
}
