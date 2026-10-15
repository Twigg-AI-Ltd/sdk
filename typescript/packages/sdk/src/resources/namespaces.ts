import { Page, PagePromise } from "../core/pagination.js";
import { Resource } from "../core/resource.js";
import type { RequestOptions } from "../core/transport.js";
import type { Namespace, NamespacePage } from "../types.js";

export class Namespaces extends Resource {
  /**
   * Every namespace chats use, ascending. Returned as a page, like every other listing, so code
   * keeps working if the endpoint starts paginating.
   */
  list(options?: RequestOptions): PagePromise<Namespace> {
    return new PagePromise(async () => {
      const page = await this.transport.json<NamespacePage>(
        { method: "GET", path: "/api/v1/namespaces", auth: "required", idempotent: true },
        options,
      );
      return new Page(page.data, false, undefined);
    });
  }
}
