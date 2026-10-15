import type { RequestOptions } from "../../core/transport.js";
import type {
  DeactivateResponse,
  PublishRetentionPolicyRequest,
  RetentionPolicyId,
  RetentionPolicyVersion,
} from "../../types.js";
import { ConfigSurface, type ScopeQuery } from "./surface.js";

/** Retention policies: what of a chat's history is replayed, and how it is cut down. */
export class Retention extends ConfigSurface {
  protected readonly base = "/api/v1/config/retention";

  publish(
    body: PublishRetentionPolicyRequest,
    options?: RequestOptions,
  ): Promise<RetentionPolicyVersion> {
    return this.publishTo(body, options);
  }

  /** Every version in exactly this scope, with its rules. */
  versions(query: ScopeQuery = {}, options?: RequestOptions): Promise<RetentionPolicyVersion[]> {
    return this.getAt("", { ...query }, options);
  }

  restore(id: RetentionPolicyId, options?: RequestOptions): Promise<RetentionPolicyVersion> {
    return this.restoreAt(id, options);
  }

  withdraw(query: ScopeQuery = {}, options?: RequestOptions): Promise<DeactivateResponse> {
    return this.withdrawAt({ ...query }, options);
  }
}
