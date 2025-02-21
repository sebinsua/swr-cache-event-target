import { attachPromiseMeta, PromiseWithMeta } from "./PromiseWithMeta";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

function defaultGetKey(...args: unknown[]) {
  return `key-${args.map((arg) => String(arg)).join("-")}`;
}

interface RefreshStrategyOptions<Param, Value> {
  refresh: () => void;
  config: SwrCacheConfig<Param, Value>;
  signal: AbortSignal;
}

function defaultRefreshStrategy<Param, Value>({
  refresh,
  config,
  signal,
}: RefreshStrategyOptions<Param, Value>) {
  const interval = setInterval(() => {
    if (signal.aborted) {
      return;
    }
    refresh();
  }, config.refreshIntervalMs);

  signal.addEventListener("abort", () => clearInterval(interval));
}

export type CacheEntry<P, V> = {
  param: P;
  promise: PromiseWithMeta<V>;
  refresh: Promise<void> | null;
  expiry: number;
};

export type SwrCacheEntryState = "stale" | "resolved" | "rejected";

export type SwrCacheEvents<Param, Value> = {
  "state:missing": CustomEvent<{
    key: string;
    param: Param;
  }>;
  "state:update": CustomEvent<{
    type: SwrCacheEntryState;
    key: string;
    param: Param;
    value?: Value;
    error?: unknown;
  }>;
  "state:prime": CustomEvent<{ key: string } | { param: Param }>;
  "state:reset": CustomEvent<void>;
};

export type SwrCacheConfig<Param, Value> = {
  getValue: (param: Param) => Promise<Value>;
  getKey?: (param: Param) => string;
  ttlMs?: number;
  refreshStrategy?: (options: RefreshStrategyOptions<Param, Value>) => void;
  refreshIntervalMs?: number;
};

export class SwrCache<Param, Value> extends EventTarget {
  #config: Required<SwrCacheConfig<Param, Value>>;
  #cache: Map<string, CacheEntry<Param, Value>> = new Map();
  #abortController = new AbortController();
  epoch = 0;

  constructor(config: SwrCacheConfig<Param, Value>) {
    super();

    this.#config = {
      getKey: defaultGetKey,
      ttlMs: DEFAULT_TTL_MS,
      refreshStrategy: defaultRefreshStrategy,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      ...config,
    };
    if (this.#config.refreshIntervalMs <= this.#config.ttlMs) {
      throw new Error("`refreshIntervalMs` must be greater than `ttlMs`.");
    }

    this.addEventListener(
      "state:prime",
      (event) => {
        const [key, param] =
          "param" in event.detail
            ? [this.#config.getKey(event.detail.param), event.detail.param]
            : [event.detail.key, event.detail.key as Param];
        const [, entry] = this.#getEntry(param);
        if (entry) {
          if (
            entry.promise.status === "fulfilled" &&
            entry.promise.value !== undefined
          ) {
            this.dispatchEvent(
              new CustomEvent("state:update", {
                detail: {
                  type: "resolved",
                  key: key,
                  param: entry.param,
                  value: entry.promise.value,
                },
              }),
            );
          }
          void this.#refreshEntry(key, entry, this.epoch);
        }
      },
      { signal: this.#abortController.signal },
    );

    const refreshStrategy = this.#config.refreshStrategy;
    refreshStrategy({
      refresh: () => this.#refreshStaleEntries(),
      config: this.#config,
      signal: this.#abortController.signal,
    });
  }

  async #createRefresh(
    key: string,
    entry: CacheEntry<Param, Value>,
    currentEpoch: number,
  ) {
    try {
      const promise = attachPromiseMeta(this.#config.getValue(entry.param));

      this.#cache.set(key, {
        param: entry.param,
        promise: promise,
        refresh: null,
        expiry: performance.now() + this.#config.ttlMs,
      });

      const value = await promise;

      if (
        this.epoch === currentEpoch &&
        !this.#abortController.signal.aborted
      ) {
        this.dispatchEvent(
          new CustomEvent("state:update", {
            detail: { type: "resolved", key, param: entry.param, value },
          }),
        );
      }
    } catch (error) {
      if (
        this.epoch === currentEpoch &&
        !this.#abortController.signal.aborted
      ) {
        this.#cache.delete(key);
        this.dispatchEvent(
          new CustomEvent("state:update", {
            detail: { type: "rejected", key, param: entry.param, error },
          }),
        );
      }
    } finally {
      entry.refresh = null;
    }
  }

  #refreshEntry(
    key: string,
    entry: CacheEntry<Param, Value>,
    currentEpoch: number,
  ) {
    // If there's already a refresh underway, return it.
    if (entry.refresh) {
      return entry.refresh;
    }

    entry.refresh = this.#createRefresh(key, entry, currentEpoch);
  }

  async #refreshStaleEntries() {
    if (this.#cache.size === 0) {
      return;
    }

    const now = performance.now();
    const staleEntries = Array.from(this.#cache.entries()).filter(
      ([_, entry]) =>
        entry.expiry <= now && entry.promise.status === "fulfilled",
    );

    const currentEpoch = this.epoch;
    for (const [key, entry] of staleEntries) {
      await this.#refreshEntry(key, entry, currentEpoch);
    }
  }

  #getEntry(param: Param): [key: string, entry: CacheEntry<Param, Value>] {
    const key = this.#config.getKey(param);
    const entry = this.#cache.get(key);
    const currentEpoch = this.epoch;

    if (!entry) {
      const promise = attachPromiseMeta(this.#config.getValue(param));

      promise.then(
        (value) => {
          if (
            this.epoch === currentEpoch &&
            !this.#abortController.signal.aborted
          ) {
            this.dispatchEvent(
              new CustomEvent("state:update", {
                detail: { type: "resolved", key, param, value },
              }),
            );
          }
        },
        (error) => {
          if (
            this.epoch === currentEpoch &&
            !this.#abortController.signal.aborted
          ) {
            this.#cache.delete(key);
            this.dispatchEvent(
              new CustomEvent("state:update", {
                detail: { type: "rejected", key, param, error },
              }),
            );
          }
        },
      );

      this.dispatchEvent(
        new CustomEvent("state:missing", { detail: { key, param } }),
      );

      const entry: CacheEntry<Param, Value> = {
        param,
        promise,
        refresh: null,
        expiry: performance.now() + this.#config.ttlMs,
      };
      this.#cache.set(key, entry);

      return [key, entry];
    }

    return [key, entry];
  }

  /**
   * GetAsync will always return a *stable* Promise containing the requested value.
   */
  getAsync(param: Param): PromiseWithMeta<Value> {
    if (this.#abortController.signal.aborted) {
      return Promise.reject(
        new Error("Cache instance has been destroyed and is no longer viable."),
      );
    }

    const [key, entry] = this.#getEntry(param);
    if (
      entry.promise.status === "fulfilled" &&
      entry.promise.value !== undefined
    ) {
      const now = performance.now();
      if (entry.expiry <= now) {
        this.dispatchEvent(
          new CustomEvent("state:update", {
            detail: {
              type: "stale",
              key,
              param: entry.param,
              value: entry.promise.value,
            },
          }),
        );

        void this.#refreshEntry(key, entry, this.epoch);
      }
    }

    return entry.promise;
  }

  /**
   * Read will attempt to synchronously read the cache, but fallback to
   * initializing and returning a Promise if the cache is empty.
   */
  read(param: Param): Value | PromiseWithMeta<Value> {
    const promise = this.getAsync(param);
    if (promise.status === "fulfilled" && promise.value !== undefined) {
      return promise.value;
    }

    return promise;
  }

  /**
   * Prime either initializes a cache entry or revalidates it, returning void.
   */
  prime(param: Param) {
    void this.getAsync(param);
  }

  /**
   * Peek will always synchronously read the cache.
   *
   * Note: `peek` can revalidate cache entries in the background but is otherwise side-effect free.
   */
  peek(param: Param): Value | undefined {
    const key = this.#config.getKey(param);
    const entry = this.#cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (
      entry.promise.status === "fulfilled" &&
      entry.promise.value !== undefined
    ) {
      const now = performance.now();
      if (entry.expiry <= now) {
        this.prime(param);
      }

      return entry.promise.value;
    }

    return undefined;
  }

  onMissing(cb: EventListener) {
    this.addEventListener("state:missing", cb, {
      signal: this.#abortController.signal,
    });
  }

  clear() {
    this.epoch++;
    this.#cache.clear();
    this.dispatchEvent(new CustomEvent("state:reset"));
  }

  destroy() {
    this.epoch++;
    this.#cache.clear();
    this.#abortController.abort();
  }

  addEventListener<K extends keyof SwrCacheEvents<Param, Value>>(
    type: K,
    listener: (ev: SwrCacheEvents<Param, Value>[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const opts =
      typeof options === "object" && options !== null
        ? options
        : { capture: options !== false };
    super.addEventListener(type, listener, {
      ...opts,
      signal: this.#abortController.signal,
    });
  }

  removeEventListener<K extends keyof SwrCacheEvents<Param, Value>>(
    type: K,
    listener: (ev: SwrCacheEvents<Param, Value>[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }
}
