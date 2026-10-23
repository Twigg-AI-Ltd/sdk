import { Resource } from "../core/resource.js";
import type { RequestOptions } from "../core/transport.js";
import type { Catalogue, CatalogueModelResponse } from "../types.js";

/**
 * The public model catalogue. No API key needed; with one, prices reflect the organisation's own
 * rate.
 */
export class CatalogueResource extends Resource {
  list(options?: RequestOptions): Promise<Catalogue> {
    return this.transport.json(
      { method: "GET", path: "/v1/catalogue", auth: "optional", idempotent: true },
      options,
    );
  }

  /** One model by catalogue name. Names may contain slashes. */
  get(name: string, options?: RequestOptions): Promise<CatalogueModelResponse> {
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    return this.transport.json(
      { method: "GET", path: `/v1/catalogue/${encoded}`, auth: "optional", idempotent: true },
      options,
    );
  }

  /** The catalogue as a Markdown table, for prompts and docs. */
  markdown(options?: RequestOptions): Promise<string> {
    return this.transport.text(
      { method: "GET", path: "/v1/catalogue/models.md", auth: "optional", idempotent: true },
      { ...options, headers: { Accept: "text/plain", ...options?.headers } },
    );
  }
}
