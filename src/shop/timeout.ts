// A network call that can never hang forever (FB-001019).
// On a phone, a request can stall for good when the connection drops, the app is backgrounded to open a bank app, or the phone switches between Wi-Fi and
// mobile data. A promise that never settles leaves the checkout button disabled ("placing order…") and nothing can be done except killing the app.
// With a time limit the call fails with a retryable error instead. That is safe for the shop's calls: placing an order carries an idempotency key, so a
// retry returns the order that was already created instead of making a second one.

export class TimeoutError extends Error {
  constructor(public ms: number) { super(`timeout after ${ms} ms`); this.name = 'TimeoutError'; }
}

/**
 * Run `run`, giving it an AbortSignal that fires after `ms`. The returned promise rejects with TimeoutError at that moment even if `run` ignores the signal.
 * The result of a call that finishes in time is returned untouched.
 */
export async function withTimeout<T>(run: (signal: AbortSignal) => PromiseLike<T> | T, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new TimeoutError(ms)); }, ms); });
  try { return await Promise.race([Promise.resolve(run(ctl.signal)), limit]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
