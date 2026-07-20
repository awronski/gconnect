import { setTimeout as delay } from "node:timers/promises";
import { CliError, ProtocolChangedError, isCliError } from "../core/errors.js";
import { parseGarminJson } from "../core/parse-json.js";
import { readTextLimited } from "../core/response-body.js";
import { fetchWithCookieJar, type Fetch } from "../auth/web/cookie-fetch.js";
import type { WebSessionManager } from "../auth/web/web-session-manager.js";
import type { GarminDownloadService, JsonRequest, QueryValue } from "./contracts.js";

export interface WebGarminDownloadOptions {
  readonly sessions: WebSessionManager;
  readonly fetch: Fetch;
  readonly origin?: string;
  readonly maximumResponseBytes?: number;
  readonly maximumAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class WebGarminDownloadService implements GarminDownloadService {
  readonly #sessions: WebSessionManager;
  readonly #fetch: Fetch;
  readonly #origin: string;
  readonly #maximumResponseBytes: number;
  readonly #maximumAttempts: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  public constructor(options: WebGarminDownloadOptions) {
    this.#sessions = options.sessions;
    this.#fetch = options.fetch;
    this.#origin = options.origin ?? "https://connect.garmin.com";
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 16_777_216;
    this.#maximumAttempts = options.maximumAttempts ?? 3;
    this.#sleep = options.sleep ?? (async (milliseconds) => delay(milliseconds));
  }

  public json<T>(request: JsonRequest<T>): Promise<T> {
    return this.#request(request, false) as Promise<T>;
  }

  public optionalJson<T>(request: JsonRequest<T>): Promise<T | null> {
    return this.#request(request, true);
  }

  public async profileId(): Promise<string> {
    return (await this.#sessions.session()).profileId;
  }

  async #request<T>(request: JsonRequest<T>, optional: boolean): Promise<T | null> {
    let refreshedCsrf = false;
    let forceBootstrap = false;
    let transientAttempts = 0;
    while (true) {
      const url = buildUrl(this.#origin, request.path, request.query);
      let response: Response;
      try {
        const session = await this.#sessions.session(forceBootstrap, request.signal);
        forceBootstrap = false;
        response = await fetchWithCookieJar(session.cookieJar, url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Connect-Csrf-Token": session.csrfToken,
            "User-Agent": "gconnect-cli/0.1"
          },
          signal: request.signal === undefined
            ? AbortSignal.timeout(request.timeoutMs ?? 30_000)
            : AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 30_000)])
        }, {
          fetch: this.#fetch,
          allowedOrigins: new Set([new URL(this.#origin).origin]),
          maximumRedirects: 0
        });
      } catch (error) {
        throwIfAborted(request.signal);
        if (isCliError(error)) throw error;
        transientAttempts += 1;
        if (transientAttempts < this.#maximumAttempts) {
          await this.#sleep(backoffMilliseconds(transientAttempts));
          continue;
        }
        throw new CliError("NETWORK_ERROR", "Unable to connect to Garmin Connect", {
          endpoint: request.path,
          attempts: transientAttempts,
          reason: error instanceof Error ? error.message : String(error)
        }, 1);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new CliError("AUTH_REQUIRED", "Garmin redirected the API request to authentication", {
          endpoint: request.path,
          recoveryCommand: "gconnect auth recover"
        }, 3);
      }
      if (response.status === 401) {
        throw new CliError("AUTH_REQUIRED", "Garmin rejected the saved session", {
          endpoint: request.path,
          recoveryCommand: "gconnect auth recover"
        }, 3);
      }
      if (response.status === 403) {
        await drainResponse(response);
        if (!refreshedCsrf) {
          refreshedCsrf = true;
          forceBootstrap = true;
          continue;
        }
        throw new CliError("AUTH_FORBIDDEN", "Garmin rejected the request after refreshing CSRF state", {
          endpoint: request.path
        }, 3);
      }
      if (response.status === 404) {
        throw new CliError("NOT_FOUND", "Garmin did not find the requested data", { endpoint: request.path }, 4);
      }
      if (response.status === 429) {
        throw new CliError("RATE_LIMITED", "Garmin rate-limited the request", {
          endpoint: request.path,
          retryAfter: response.headers.get("retry-after")
        }, 5);
      }
      if (response.status >= 500) {
        transientAttempts += 1;
        if (transientAttempts < this.#maximumAttempts) {
          await drainResponse(response);
          await this.#sleep(backoffMilliseconds(transientAttempts));
          continue;
        }
        throw new CliError("GARMIN_UNAVAILABLE", "Garmin returned a server error", {
          endpoint: request.path,
          status: response.status,
          attempts: transientAttempts
        }, 1);
      }
      if (response.status === 204) {
        await this.#sessions.persist();
        if (optional) return null;
        return decodeResponse(request, null);
      }
      if (!response.ok) {
        throw new CliError("GARMIN_REQUEST_FAILED", "Garmin rejected the request", {
          endpoint: request.path,
          status: response.status
        }, 1);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let text: string;
      try {
        text = await readTextLimited(response, this.#maximumResponseBytes);
      } catch (error) {
        throwIfAborted(request.signal);
        if (isCliError(error)) throw error;
        transientAttempts += 1;
        if (transientAttempts < this.#maximumAttempts) {
          await this.#sleep(backoffMilliseconds(transientAttempts));
          continue;
        }
        throw new CliError("NETWORK_ERROR", "Unable to read the Garmin Connect response", {
          endpoint: request.path,
          attempts: transientAttempts,
          reason: error instanceof Error ? error.message : String(error)
        }, 1);
      }
      if (contentType.includes("text/html") || /^\s*</.test(text)) {
        throw new CliError("AUTH_REQUIRED", "Garmin returned HTML instead of API JSON", {
          endpoint: request.path,
          recoveryCommand: "gconnect auth recover"
        }, 3);
      }
      let input: unknown;
      try {
        input = parseGarminJson(text);
      } catch (error) {
        throw new ProtocolChangedError({ endpoint: request.path, issue: "invalid JSON response" }, error);
      }
      const decoded = decodeResponse(request, input);
      await this.#sessions.persist();
      return decoded;
    }
  }
}

function decodeResponse<T>(request: JsonRequest<T>, input: unknown): T {
  try {
    return request.decode(input);
  } catch (error) {
    if (error instanceof ProtocolChangedError) throw error;
    throw new ProtocolChangedError({
      endpoint: request.path,
      issue: "response decoder rejected payload",
      reason: error instanceof Error ? error.message : String(error)
    }, error);
  }
}

function buildUrl(origin: string, path: string, query: Readonly<Record<string, QueryValue>> | undefined): URL {
  const url = new URL(path, origin);
  for (const name of Object.keys(query ?? {}).sort()) {
    const value = query?.[name];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(name, String(item));
  }
  return url;
}

function backoffMilliseconds(attempt: number): number {
  return Math.min(2_000, 200 * (2 ** (attempt - 1)));
}

async function drainResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new CliError("CANCELLED", "Garmin request was cancelled", {}, 130);
}
