import { Page } from "./pagination.js";

/**
 * A page whose iteration follows the paging direction. The API returns chats newest first and
 * history oldest first whichever way you page, so iterating backwards through history (or
 * forwards through chats) reverses each page to keep the item stream in one consistent order.
 */
export class DirectionalPage<T> extends Page<T> {
  constructor(
    data: T[],
    hasMore: boolean,
    fetchNext: (() => Promise<DirectionalPage<T>>) | undefined,
    private readonly reverse: boolean,
  ) {
    super(data, hasMore, fetchNext);
  }

  protected override items(): T[] {
    return this.reverse ? [...this.data].reverse() : this.data;
  }
}
