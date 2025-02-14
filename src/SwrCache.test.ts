import { describe, it, expect, vi, afterEach } from "vitest";
import { SwrCache } from "./SwrCache";

describe("SwrCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should async read cache to populate it with sync value", async () => {
    const resolvedValue = "hello";
    const mockGetValue = vi.fn().mockResolvedValue(resolvedValue);
    function getValue(param: string): Promise<typeof resolvedValue> {
      return mockGetValue(param);
    }

    const cache = new SwrCache({
      getValue,
      getKey: (param) => `key-${param}`,
      ttlMs: 1000,
    });

    try {
      const readPromise = cache.read("test-param");
      expect(readPromise).toBeInstanceOf(Promise);
      expect(await readPromise).toBe(resolvedValue);
      expect(cache.read("test-param")).toBe(resolvedValue);
      expect(mockGetValue).toBeCalledTimes(1);
    } finally {
      cache.destroy();
    }
  });

  it("should emit 'resolved' event on populating cache", async () => {
    const resolvedValue = "hello";
    const mockGetValue = vi.fn().mockResolvedValue(resolvedValue);
    function getValue(param: string): Promise<typeof resolvedValue> {
      return mockGetValue(param);
    }

    const cache = new SwrCache({
      getValue,
      getKey: (param) => `key-${param}`,
      ttlMs: 1000,
    });

    let resolvedEvent: CustomEvent | null = null;
    cache.addEventListener("cache:change", (e) => {
      if (e.detail.type === "resolved") {
        resolvedEvent = e;
      }
    });

    try {
      await cache.read("test-param");
      expect(resolvedEvent).toBeDefined();
      expect(resolvedEvent!.detail).toEqual({
        type: "resolved",
        param: "test-param",
        value: resolvedValue,
      });
    } finally {
      cache.destroy();
    }
  });

  it("should not populate cache when async read rejects", async () => {
    const error = new Error("fail");
    const mockGetValue = vi.fn().mockRejectedValue(error);
    function getValue(param: string): Promise<string> {
      return mockGetValue(param);
    }
    const cache = new SwrCache({
      getValue,
      getKey: (param: string) => `key-${param}`,
      ttlMs: 1000,
    });

    let rejectedEvent: CustomEvent | null = null;
    cache.addEventListener("cache:change", (e: CustomEvent) => {
      if (e.detail.type === "rejected") {
        rejectedEvent = e;
      }
    });

    try {
      await expect(cache.read("fail-param")).rejects.toThrow("fail");
      expect(rejectedEvent).not.toBeNull();
      expect(rejectedEvent!.detail).toEqual({
        type: "rejected",
        param: "fail-param",
        error,
      });

      // Reads still asynchronous as cache not populated.
      const readPromise = cache.read("fail-param");
      expect(readPromise).toBeInstanceOf(Promise);
      expect(mockGetValue).toBeCalledTimes(2);
    } finally {
      cache.destroy();
    }
  });

  it("should refresh stale cache entries in the background emitting 'cache:change' events", async () => {
    // Use fake timers to simulate TTL expiry.
    vi.useFakeTimers();

    // First call returns "initial", subsequent calls return "updated".
    let callCount = 0;
    const getValue = vi.fn(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? "initial" : "updated");
    });

    const ttlMs = 50;
    const refreshIntervalMs = 1000;
    const cache = new SwrCache({
      getValue,
      getKey: (param: string) => `key-${param}`,
      ttlMs,
      refreshIntervalMs,
    });

    const events: CustomEvent[] = [];
    cache.addEventListener("cache:change", (e: CustomEvent) => {
      events.push(e);
    });

    try {
      // Prime the cache.
      const initial = await cache.read("param");
      expect(initial).toBe("initial");
      expect(getValue).toHaveBeenCalledTimes(1);

      // Advance time past the TTL so that the entry becomes stale.
      vi.advanceTimersByTime(100);

      // Calling read should synchronously return the stale cached value and trigger a refresh.
      const staleValue = cache.read("param");
      expect(staleValue).toBe("initial");

      // Advance timers by the refresh interval so that one refresh cycle occurs.
      await vi.advanceTimersByTimeAsync(refreshIntervalMs);

      // Subsequent read should return the updated value.
      const freshValue = cache.read("param");
      expect(freshValue).toBe("updated");

      // Verify that the events contain a 'stale' event and a later 'resolved' event.
      const staleEvents = events.filter((e) => e.detail.type === "stale");
      expect(staleEvents.length).toBeGreaterThan(0);
      expect(staleEvents.at(0)?.detail.value).toBe("initial");
      const resolvedEvents = events.filter((e) => e.detail.type === "resolved");
      expect(resolvedEvents.length).toBeGreaterThan(0);
      expect(resolvedEvents.at(-1)?.detail.value).toBe("updated");
    } finally {
      cache.destroy();
    }
  });

  it("should populate cache when `prime` called", async () => {
    vi.useFakeTimers();

    const resolvedValue = "primed";
    const getValue = vi.fn(() => Promise.resolve(resolvedValue));
    const cache = new SwrCache({
      getValue,
      getKey: (param: string) => `key-${param}`,
      ttlMs: 1000,
      refreshIntervalMs: 2000,
    });

    try {
      // Initially, `peek` should return `undefined` since no entry exists.
      expect(cache.peek("foo")).toBeUndefined();

      // After triggering a background refresh
      cache.prime("foo");
      // ...and waiting for the async operation to settle.
      await vi.advanceTimersByTimeAsync(0);

      // `peek` will now return the primed value.
      expect(cache.peek("foo")).toBe(resolvedValue);
      expect(getValue).toHaveBeenCalledTimes(1);
    } finally {
      cache.destroy();
    }
  });

  it("should clear the cache and emit a 'cache:clear' event", async () => {
    const getValue = vi.fn().mockResolvedValue("value");
    const cache = new SwrCache({
      getValue,
      getKey: (param: string) => `key-${param}`,
      ttlMs: 1000,
    });

    let clearEventEmitted = false;
    cache.addEventListener("cache:clear", () => {
      clearEventEmitted = true;
    });

    try {
      // Prime the cache.
      await cache.read("foo");

      // Clear the cache.
      cache.clear();
      expect(clearEventEmitted).toBe(true);

      // A subsequent read should re-trigger getValue.
      await cache.read("foo");
      expect(getValue).toHaveBeenCalledTimes(2);
    } finally {
      cache.destroy();
    }
  });

  it("should destroy the cache and prevent further event emissions", async () => {
    const getValue = vi.fn().mockResolvedValue("value");
    const cache = new SwrCache({
      ttlMs: 1000,
      getValue,
      getKey: (param: string) => `key-${param}`,
    });

    const capturedEvents: CustomEvent[] = [];
    cache.addEventListener("cache:change", (e: CustomEvent) => {
      capturedEvents.push(e);
    });

    // Prime the cache.
    await cache.read("foo");
    const eventsBeforeDestroy = capturedEvents.length;

    // Destroy the cache.
    cache.destroy();

    // After destroy, reading should throw and not dispatch events.
    await expect(cache.read("foo")).rejects.toThrow(
      "Cache instance has been destroyed and is no longer viable.",
    );
    expect(capturedEvents.length).toBe(eventsBeforeDestroy);
  });
});
