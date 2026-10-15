import { Resource } from "../core/resource.js";
import type { RequestOptions } from "../core/transport.js";
import type { ApiVersion, Discovery, PlatformUpdate } from "../types.js";

/** Discovery, version and platform updates. No API key needed. */
export class Meta extends Resource {
  /** Links to the docs, OpenAPI document and llms.txt. */
  discovery(options?: RequestOptions): Promise<Discovery> {
    return this.transport.json(
      { method: "GET", path: "/", auth: "optional", idempotent: true },
      options,
    );
  }

  version(options?: RequestOptions): Promise<ApiVersion> {
    return this.transport.json(
      { method: "GET", path: "/api/v1/version", auth: "optional", idempotent: true },
      options,
    );
  }

  /** Published platform updates: releases, notices and maintenance. */
  updates(options?: RequestOptions): Promise<PlatformUpdate[]> {
    return this.transport.json(
      { method: "GET", path: "/api/v1/updates", auth: "optional", idempotent: true },
      options,
    );
  }
}
