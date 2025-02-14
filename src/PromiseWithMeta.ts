export type PromiseWithMeta<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
  reason?: unknown;
};

export function attachPromiseMeta<T>(p: PromiseLike<T>): PromiseWithMeta<T> {
  const promise = p as PromiseWithMeta<T>;
  promise.status = "pending";
  promise.then(
    (v) => {
      promise.status = "fulfilled";
      promise.value = v;
    },
    (e) => {
      promise.status = "rejected";
      promise.reason = e;
    },
  );
  return promise;
}
