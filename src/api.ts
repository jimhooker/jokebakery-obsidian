/**
 * HTTP client for the JokeBakery `/api/sync/*` endpoints.
 *
 * Uses Obsidian's `requestUrl` rather than fetch: it runs in the main process,
 * so it isn't subject to CORS and works the same on desktop and mobile.
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { ChangesResult, PushBody, PushResponse } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/** How long to wait before the single retry. Long enough for a suspended
 *  database to finish waking, short enough not to stall a manual sync. */
const RETRY_DELAY_MS = 2_000;

/**
 * requestUrl has no timeout of its own; without one a dead connection leaves
 * the whole sync (and the status bar) stuck on "syncing" forever.
 *
 * Note this only stops US waiting - the underlying request keeps running to
 * completion in the background, since requestUrl exposes no way to abort it.
 * That's harmless (the response is simply discarded) but it does mean a
 * timeout is not a guarantee the server didn't act on the request.
 */
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new ApiError(`${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, 0)),
      REQUEST_TIMEOUT_MS
    );
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Is this worth trying once more?
 *
 * Yes for the failures that are about the connection rather than the request:
 * a timeout, a dropped network, or a 5xx. The database this talks to suspends
 * when idle and cold-starts on the next request, which surfaces as a short
 * burst of 500s that recovers on its own - without a retry that lands in the
 * user's face as "sync error" for something already fixed by the time they
 * read it.
 *
 * No for anything the server answered deliberately: 401 (bad token), 402
 * (lapsed subscription), 400 (a field we shouldn't have sent). Those fail the
 * same way every time, and retrying a push risks repeating a write.
 */
function isTransient(status: number): boolean {
  return status === 0 || status >= 500;
}

export class JokeBakeryApi {
  constructor(
    private serverUrl: string,
    private token: string
  ) {}

  private base(): string {
    return this.serverUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private check(res: RequestUrlResponse, what: string): void {
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 401) {
      throw new ApiError("Unauthorized — check your access token.", 401);
    }
    const body = res.json as { error?: unknown } | undefined;
    const detail =
      (body && typeof body.error === "string" && body.error) ||
      `HTTP ${res.status}`;
    throw new ApiError(`${what} failed: ${detail}`, res.status);
  }

  /**
   * Run a request, retrying once if it failed for a reason that might not
   * happen again. See isTransient - deliberate 4xx answers are not retried.
   */
  private async request(
    what: string,
    send: () => Promise<RequestUrlResponse>
  ): Promise<RequestUrlResponse> {
    for (let attempt = 0; ; attempt++) {
      let res: RequestUrlResponse;
      try {
        res = await withTimeout(send(), what);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (attempt === 0 && isTransient(status)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
      if (attempt === 0 && isTransient(res.status)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      this.check(res, what);
      return res;
    }
  }

  /** Validate base URL + token. Returns the token's display name. */
  async whoami(): Promise<{ userId: string; tokenName: string }> {
    const res = await this.request("Connection", () =>
      requestUrl({
        url: `${this.base()}/api/sync/whoami`,
        method: "GET",
        headers: this.headers(),
        throw: false,
      })
    );
    const body = res.json as { userId: string; tokenName: string };
    return { userId: body.userId, tokenName: body.tokenName };
  }

  /** Pull everything changed since the cursor (omit for a full sync). */
  async changes(since: string): Promise<ChangesResult> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await this.request("Pull", () =>
      requestUrl({
        url: `${this.base()}/api/sync/changes${qs}`,
        method: "GET",
        headers: this.headers(),
        throw: false,
      })
    );
    return res.json as ChangesResult;
  }

  /**
   * Push created/updated items.
   *
   * Retried on a transient failure like everything else. That is safe despite
   * being a write: every item carries either its own id or a `ref` the server
   * echoes back, so a repeated push updates the same rows rather than
   * duplicating them, and a create that already landed is recognised by id.
   */
  async push(body: PushBody): Promise<PushResponse> {
    const res = await this.request("Push", () =>
      requestUrl({
        url: `${this.base()}/api/sync/push`,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        throw: false,
      })
    );
    return res.json as PushResponse;
  }
}
