import type { RequestOptions } from "../../core/transport.js";
import { path } from "../../core/transport.js";
import type {
  ConfigVersion,
  DeactivateResponse,
  InstructionVersion,
  PublishInstructionRequest,
  SystemInstructionId,
} from "../../types.js";
import { ConfigSurface, type ScopeQuery } from "./surface.js";

/** System instructions. `append` adds to the parent scope's; `replace` cuts the chain there. */
export class Instructions extends ConfigSurface {
  protected readonly base = "/api/v1/config/instructions";

  publish(body: PublishInstructionRequest, options?: RequestOptions): Promise<ConfigVersion> {
    return this.publishTo(body, options);
  }

  /** Every version in exactly this scope (not its children), without bodies. */
  versions(query: ScopeQuery = {}, options?: RequestOptions): Promise<ConfigVersion[]> {
    return this.getAt("", { ...query }, options);
  }

  /** One version with its body. */
  get(id: SystemInstructionId, options?: RequestOptions): Promise<InstructionVersion> {
    return this.getAt(path`/${id}`, {}, options);
  }

  restore(id: SystemInstructionId, options?: RequestOptions): Promise<ConfigVersion> {
    return this.restoreAt(id, options);
  }

  withdraw(query: ScopeQuery = {}, options?: RequestOptions): Promise<DeactivateResponse> {
    return this.withdrawAt({ ...query }, options);
  }
}
