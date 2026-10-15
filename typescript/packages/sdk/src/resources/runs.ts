import { Resource } from "../core/resource.js";
import { path, type RequestOptions } from "../core/transport.js";
import { TimeoutError } from "../errors.js";
import type { RunId, RunInspection } from "../types.js";

export class Runs extends Resource {
  /** A run's status, usage, cost once settled, and the configuration it used. */
  get(runId: RunId, options?: RequestOptions): Promise<RunInspection> {
    return this.transport.json(
      { method: "GET", path: path`/api/v1/runs/${runId}`, auth: "required", idempotent: true },
      options,
    );
  }

  /**
   * Wait until the run's charge has landed, polling with backoff, and return it with `cost`
   * set. A turn's `done` event carries a null cost when settlement is still pending; settlement
   * can lag by seconds or, rarely, hours. Throws TimeoutError after `wait` milliseconds
   * (default 10 minutes).
   */
  async waitForSettlement(
    runId: RunId,
    options: RequestOptions & { wait?: number } = {},
  ): Promise<RunInspection> {
    const { wait = 600_000, ...request } = options;
    const deadline = Date.now() + wait;
    for (let delay = 1_000; ; delay = Math.min(delay * 2, 30_000)) {
      const run = await this.get(runId, request);
      if (run.settled_at || (run.status !== "running" && run.cost !== null)) return run;
      if (Date.now() + delay > deadline)
        throw new TimeoutError(`Run ${runId} had not settled after ${wait}ms`, {
          code: "settlement_timeout",
        });
      await this.transport.pause(delay, request.signal);
    }
  }
}
