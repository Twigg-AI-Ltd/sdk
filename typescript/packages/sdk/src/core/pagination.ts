// Pages that know how to fetch the next one, and list calls that can be awaited for one page or
// iterated for every item:
//
//   const page = await twigg.chats.list();          // one page
//   for await (const chat of twigg.chats.list()) {}  // every chat, fetching pages as needed

export class Page<T> implements AsyncIterable<T> {
  constructor(
    /** The items on this page, in the order the API returned them. */
    readonly data: T[],
    /** Whether the API says more items exist in the direction being paged. */
    readonly hasMore: boolean,
    private readonly fetchNext: (() => Promise<Page<T>>) | undefined,
  ) {}

  hasNextPage(): boolean {
    return this.hasMore && this.fetchNext !== undefined;
  }

  /** The next page in the direction being paged, or `null` at the end. */
  async nextPage(): Promise<Page<T> | null> {
    return this.hasNextPage() && this.fetchNext ? this.fetchNext() : null;
  }

  /** This page and every following one. */
  async *pages(): AsyncGenerator<Page<T>> {
    let page: Page<T> | null = this;
    while (page) {
      yield page;
      page = await page.nextPage();
    }
  }

  /** Every item from this page onward, in iteration order (see each list method). */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for await (const page of this.pages()) yield* page.items();
  }

  /** The order items are yielded in when iterating. A subclass may reverse it. */
  protected items(): T[] {
    return this.data;
  }
}

/**
 * The result of a list call: await it for the first page, or iterate it for every item. Nothing
 * is fetched until one of the two happens, so an unused call never fails unobserved.
 */
export class PagePromise<T, P extends Page<T> = Page<T>>
  implements PromiseLike<P>, AsyncIterable<T>
{
  private loaded: Promise<P> | undefined;

  constructor(private readonly load: () => Promise<P>) {}

  // biome-ignore lint/suspicious/noThenProperty: a list call is deliberately awaitable.
  then<A = P, B = never>(
    onFulfilled?: ((page: P) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.page().then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<P | B> {
    return this.page().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<P> {
    return this.page().finally(onFinally);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    yield* await this.page();
  }

  private page(): Promise<P> {
    this.loaded ??= this.load();
    return this.loaded;
  }
}
