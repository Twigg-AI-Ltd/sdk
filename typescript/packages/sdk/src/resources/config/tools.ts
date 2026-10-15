import type { RequestOptions } from "../../core/transport.js";
import { path } from "../../core/transport.js";
import type {
  ConfigVersion,
  DeactivateResponse,
  PublishToolsRequest,
  ToolSchemaId,
  ToolsVersion,
} from "../../types.js";
import { ConfigSurface, type ScopeQuery } from "./surface.js";

/** Saved tool bundles, offered to every run in the scope. */
export class Tools extends ConfigSurface {
  protected readonly base = "/api/v1/config/tools";

  publish(body: PublishToolsRequest, options?: RequestOptions): Promise<ConfigVersion> {
    return this.publishTo(body, options);
  }

  /** Every version in exactly this scope (not its children), without definitions. */
  versions(query: ScopeQuery = {}, options?: RequestOptions): Promise<ConfigVersion[]> {
    return this.getAt("", { ...query }, options);
  }

  /** One version with its definitions. */
  get(id: ToolSchemaId, options?: RequestOptions): Promise<ToolsVersion> {
    return this.getAt(path`/${id}`, {}, options);
  }

  restore(id: ToolSchemaId, options?: RequestOptions): Promise<ConfigVersion> {
    return this.restoreAt(id, options);
  }

  withdraw(query: ScopeQuery = {}, options?: RequestOptions): Promise<DeactivateResponse> {
    return this.withdrawAt({ ...query }, options);
  }
}
