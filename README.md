# `swr-cache-event-target`

> A `stale-while-revalidate` cache with synchronous reads, background refreshes and event emitting.

<div>
    <a href="https://www.npmjs.com/package/swr-cache-event-target">
      <img src="https://badgen.net/npm/v/swr-cache-event-target?" alt="NPM Version" />
    </a>
    <a href="https://github.com/sebinsua/swr-cache-event-target/actions/workflows/main.yml">
      <img src="https://github.com/sebinsua/swr-cache-event-target/workflows/CI/badge.svg" alt="Build Status" />
    </a>
</div>

## Introduction

`swr-cache-event-target` is a minimal `stale-while-revalidate` cache that returns values synchronously when available while periodically revalidating them in the background. It uses the browser's `EventTarget` API to emit events when the cache is updated.

## Usage

```ts
import { SwrCache } from "swr-cache-event-target";

const cache = new SwrCache({
  getValue: async (id: string) => {
    const response = await fetch(`https://api.example.com/data?id=${id}`);
    return response.json();
  },
  ttlMs: 10_000,
});

// Initial read is asynchronous
console.log(await cache.read("123"));
// Subsequent reads are synchronous
console.log(cache.read("123"));

cache.addEventListener("state:update", (event) => {
  console.log("Cache event:", event.detail);
});
```

## Synchronous Usage

```ts
// Initially the cache is empty
console.log(cache.peek("123"));

// Prime the cache
cache.prime("123");

// Later, access the cache synchronously
console.log(cache.peek("123"));
```

## Installation

#### With `pnpm`

```sh
pnpm i swr-cache-event-target
```

#### With `npm`

```sh
npm i swr-cache-event-target
```

## Contribute

We welcome contributions! If you'd like to improve `swr-cache-event-target` or have any feedback, feel free to open an issue or submit a pull request.

## License

MIT
