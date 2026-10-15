import type { Transport } from "./transport.js";

/** Base for every resource namespace: holds the transport and nothing else. */
export abstract class Resource {
  constructor(protected readonly transport: Transport) {}
}
