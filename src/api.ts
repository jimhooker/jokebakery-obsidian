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

/** requestUrl has no timeout of its own; without one a dead connection leaves
 *  the whole sync (and the status bar) stuck on "syncing" forever. */
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
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      }
    );
  });
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
    const detail =
      (res.json && (res.json.error as string)) || `HTTP ${res.status}`;
    throw new ApiError(`${what} failed: ${detail}`, res.status);
  }

  /** Validate base URL + token. Returns the token's display name. */
  async whoami(): Promise<{ userId: string; tokenName: string }> {
    const res = await withTimeout(
      requestUrl({
        url: `${this.base()}/api/sync/whoami`,
        method: "GET",
        headers: this.headers(),
        throw: false,
      }),
      "Connection"
    );
    this.check(res, "Connection");
    return { userId: res.json.userId, tokenName: res.json.tokenName };
  }

  /** Pull everything changed since the cursor (omit for a full sync). */
  async changes(since: string): Promise<ChangesResult> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await withTimeout(
      requestUrl({
        url: `${this.base()}/api/sync/changes${qs}`,
        method: "GET",
        headers: this.headers(),
        throw: false,
      }),
      "Pull"
    );
    this.check(res, "Pull");
    return res.json as ChangesResult;
  }

  /** Push created/updated items. */
  async push(body: PushBody): Promise<PushResponse> {
    const res = await withTimeout(
      requestUrl({
        url: `${this.base()}/api/sync/push`,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        throw: false,
      }),
      "Push"
    );
    this.check(res, "Push");
    return res.json as PushResponse;
  }
}
