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
  promise: PromiseWithMeta<V>;
  expiry: number;
  param: P;
};

export type SwrCacheEntryState = "stale" | "resolved" | "rejected";

export type SwrCacheEvents<Param, Value> = {
  "state:update": CustomEvent<{
    type: SwrCacheEntryState;
    param: Param;
    value?: Value;
    error?: unknown;
  }>;
  "state:prime": CustomEvent<Param>;
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
  private config: Required<SwrCacheConfig<Param, Value>>;
  private cache: Map<string, CacheEntry<Param, Value>> = new Map();
  private epoch = 0;
  private abortController = new AbortController();

  constructor(config: SwrCacheConfig<Param, Value>) {
    super();

    this.config = {
      getKey: defaultGetKey,
      ttlMs: DEFAULT_TTL_MS,
      refreshStrategy: defaultRefreshStrategy,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      ...config,
    };
    if (this.config.refreshIntervalMs <= this.config.ttlMs) {
      throw new Error("`refreshIntervalMs` must be greater than `ttlMs`.");
    }

    this.addEventListener(
      "state:prime",
      (event) => {
        const param = event.detail;
        this.prime(param);
      },
      { signal: this.abortController.signal },
    );

    const refreshStrategy = this.config.refreshStrategy;
    refreshStrategy({
      refresh: () => this.refreshStaleEntries(),
      config: this.config,
      signal: this.abortController.signal,
    });
  }

  private async refreshEntry(
    key: string,
    entry: CacheEntry<Param, Value>,
    currentEpoch: number,
  ) {
    try {
      const promise = attachPromiseMeta(this.config.getValue(entry.param));

      this.cache.set(key, {
        promise: promise,
        expiry: performance.now() + this.config.ttlMs,
        param: entry.param,
      });

      const value = await promise;

      if (this.epoch === currentEpoch && !this.abortController.signal.aborted) {
        this.dispatchEvent(
          new CustomEvent("state:update", {
            detail: { type: "resolved", param: entry.param, value },
          }),
        );
      }
    } catch (error) {
      if (this.epoch === currentEpoch && !this.abortController.signal.aborted) {
        this.cache.delete(key);
        this.dispatchEvent(
          new CustomEvent("state:update", {
            detail: { type: "rejected", param: entry.param, error },
          }),
        );
      }
    }
  }

  private async refreshStaleEntries() {
    if (this.cache.size === 0) {
      return;
    }

    const now = performance.now();
    const staleEntries = Array.from(this.cache.entries()).filter(
      ([_, entry]) =>
        entry.expiry <= now && entry.promise.status === "fulfilled",
    );

    const currentEpoch = this.epoch;
    for (const [key, entry] of staleEntries) {
      await this.refreshEntry(key, entry, currentEpoch);
    }
  }

  #getEntry(param: Param): [key: string, entry: CacheEntry<Param, Value>] {
    const key = this.config.getKey(param);
    const entry = this.cache.get(key);
    const currentEpoch = this.epoch;

    if (!entry) {
      const promise = attachPromiseMeta(this.config.getValue(param));

      promise.then(
        (value) => {
          if (
            this.epoch === currentEpoch &&
            !this.abortController.signal.aborted
          ) {
            this.dispatchEvent(
              new CustomEvent("state:update", {
                detail: { type: "resolved", param, value },
              }),
            );
          }
        },
        (error) => {
          if (
            this.epoch === currentEpoch &&
            !this.abortController.signal.aborted
          ) {
            this.cache.delete(key);
            this.dispatchEvent(
              new CustomEvent("state:update", {
                detail: { type: "rejected", param, error },
              }),
            );
          }
        },
      );

      const entry: CacheEntry<Param, Value> = {
        promise,
        expiry: performance.now() + this.config.ttlMs,
        param,
      };
      this.cache.set(key, entry);

      return [key, entry];
    }

    return [key, entry];
  }

  getAsync(param: Param): PromiseWithMeta<Value> {
    if (this.abortController.signal.aborted) {
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
              param: entry.param,
              value: entry.promise.value,
            },
          }),
        );

        void this.refreshEntry(key, entry, this.epoch);
      }
    }

    return entry.promise;
  }

  read(param: Param): Value | PromiseWithMeta<Value> {
    const promise = this.getAsync(param);
    if (promise.status === "fulfilled" && promise.value !== undefined) {
      return promise.value;
    }

    return promise;
  }

  prime(param: Param) {
    void this.getAsync(param);
  }

  peek(param: Param): Value | undefined {
    const key = this.config.getKey(param);
    const entry = this.cache.get(key);
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

  clear() {
    this.epoch++;
    this.cache.clear();
    this.dispatchEvent(new CustomEvent("state:reset"));
  }

  destroy() {
    this.epoch++;
    this.cache.clear();
    this.abortController.abort();
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
      signal: this.abortController.signal,
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
