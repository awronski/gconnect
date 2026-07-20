import { setTimeout as delay } from "node:timers/promises";
import type { DiHttpClient, DiHttpResponse, DiTokenSet } from "../auth/di/contracts.js";
import { DiAuthError, isDiAuthError } from "../auth/di/errors.js";
import type { DiSessionManager } from "../auth/di/session-manager.js";
import { createDiApiHeaders, DI_API_BASE_URL } from "../auth/di/token-client.js";
import { CliError, isCliError, ProtocolChangedError } from "../core/errors.js";
import { expectRecord, expectString } from "../core/json.js";
import { parseGarminJson } from "../core/parse-json.js";
import type { GarminDownloadService, JsonRequest, QueryValue } from "./contracts.js";

export interface DiGarminDownloadOptions {
  readonly sessions: DiSessionManager;
  readonly http: DiHttpClient;
  readonly apiBaseUrl?: string;
  readonly maximumAttempts?: number;
  readonly maximumResponseBytes?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class DiGarminDownloadService implements GarminDownloadService {
  readonly #sessions: DiSessionManager;
  readonly #http: DiHttpClient;
  readonly #apiBaseUrl: string;
  readonly #maximumAttempts: number;
  readonly #maximumResponseBytes: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #profileId: Promise<string> | null = null;

  public constructor(options: DiGarminDownloadOptions) {
    this.#sessions = options.sessions;
    this.#http = options.http;
    this.#apiBaseUrl = (options.apiBaseUrl ?? DI_API_BASE_URL).replace(/\/$/, "");
    this.#maximumAttempts = options.maximumAttempts ?? 3;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 16_777_216;
    this.#sleep = options.sleep ?? (async (milliseconds) => delay(milliseconds));
  }

  public json<T>(request: JsonRequest<T>): Promise<T> {
    return this.#request(request, false) as Promise<T>;
  }

  public optionalJson<T>(request: JsonRequest<T>): Promise<T | null> {
    return this.#request(request, true);
  }

  public profileId(): Promise<string> {
    this.#profileId ??= this.#loadProfileId();
    return this.#profileId;
  }

  async #request<T>(request: JsonRequest<T>, optional: boolean): Promise<T | null> {
    try {
      const route = await this.#resolveRoute(request);
      return await this.#sessions.runWithSession(async (tokens) => {
        const response = await this.#getWithRetries(
          tokens,
          route,
          request.query,
          request.timeoutMs ?? 30_000,
          request.signal
        );
        return this.#decodeHttpResponse(response, request, optional);
      }, request.signal);
    } catch (error) {
      throw mapDiError(error, request.path);
    }
  }

  async #loadProfileId(): Promise<string> {
    try {
      return await this.#sessions.runWithSession(async (tokens) => {
        const response = await this.#getWithRetries(tokens, "/userprofile-service/socialProfile", undefined, 30_000);
        if (response.status === 401 || response.status === 403) {
          throw new DiAuthError("DI_TOKEN_REJECTED", "Garmin rejected the private-DI access token", {
            status: response.status
          });
        }
        if (response.status < 200 || response.status >= 300) throw statusError(response, "social profile");
        const record = expectRecord(parseResponseJson(response, this.#maximumResponseBytes), "social profile");
        const profileId = expectString(record.displayName, "social profile.displayName");
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(profileId)) {
          throw new ProtocolChangedError({
            endpoint: "/userprofile-service/socialProfile",
            issue: "displayName is not a safe profile path segment"
          });
        }
        return profileId;
      });
    } catch (error) {
      this.#profileId = null;
      throw mapDiError(error, "/userprofile-service/socialProfile");
    }
  }

  async #resolveRoute<T>(request: JsonRequest<T>): Promise<string> {
    const template = request.diPath ?? request.path.slice("/gc-api".length);
    if (
      !template.startsWith("/")
      || template.startsWith("//")
      || template.includes("?")
      || template.includes("#")
      || template.includes("\\")
      || template.includes("..")
      || /%(?:2e|2f|5c)/i.test(template)
    ) {
      throw invalidDiRoute(request.path);
    }
    const placeholders = template.match(/\{[^}]*\}/g) ?? [];
    if (placeholders.some((placeholder) => placeholder !== "{profileId}") || placeholders.length > 1) {
      throw invalidDiRoute(request.path);
    }
    if (placeholders.length === 0) return template;
    return template.replace("{profileId}", encodeURIComponent(await this.profileId()));
  }

  async #getWithRetries(
    tokens: DiTokenSet,
    route: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<DiHttpResponse> {
    const url = buildUrl(this.#apiBaseUrl, route, query);
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      try {
        const response = await this.#http.request({
          method: "GET",
          url: url.toString(),
          headers: createDiApiHeaders(tokens.accessToken),
          body: null,
          timeoutMs,
          signal
        });
        if (response.status === 401 || response.status === 403) {
          throw new DiAuthError("DI_TOKEN_REJECTED", "Garmin rejected the private-DI access token", {
            status: response.status
          });
        }
        if (response.status < 500 || attempt === this.#maximumAttempts) return response;
      } catch (error) {
        throwIfAborted(signal);
        if (isDiAuthError(error) || isCliError(error)) throw error;
        if (attempt === this.#maximumAttempts) {
          throw new CliError("NETWORK_ERROR", "Unable to connect to Garmin Connect", {
            route,
            attempts: attempt,
            reason: error instanceof Error ? error.message : String(error)
          }, 1);
        }
      }
      throwIfAborted(signal);
      await this.#sleep(backoffMilliseconds(attempt));
    }
    throw new CliError("NETWORK_ERROR", "Unable to connect to Garmin Connect", { route }, 1);
  }

  #decodeHttpResponse<T>(response: DiHttpResponse, request: JsonRequest<T>, optional: boolean): T | null {
    if (response.status === 204 && optional) return null;
    if (response.status === 404) {
      throw new CliError("NOT_FOUND", "Garmin did not find the requested data", { endpoint: request.path }, 4);
    }
    if (response.status === 429) {
      throw new CliError("RATE_LIMITED", "Garmin rate-limited the request", {
        endpoint: request.path,
        retryAfter: response.headers["retry-after"] ?? null
      }, 5);
    }
    if (response.status >= 500) {
      throw new CliError("GARMIN_UNAVAILABLE", "Garmin returned a server error", {
        endpoint: request.path,
        status: response.status,
        attempts: this.#maximumAttempts
      }, 1);
    }
    if (response.status < 200 || response.status >= 300) throw statusError(response, request.path);
    const input = response.status === 204 ? null : parseResponseJson(response, this.#maximumResponseBytes);
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
}

function invalidDiRoute(endpoint: string): CliError {
  return new CliError("INTERNAL_CONTRACT_ERROR", "Feature declared an invalid private-DI route", { endpoint }, 1);
}

function parseResponseJson(response: DiHttpResponse, maximumBytes: number): unknown {
  if (Buffer.byteLength(response.bodyText, "utf8") > maximumBytes) {
    throw new CliError("RESPONSE_TOO_LARGE", "Garmin response exceeded the configured size limit", {
      maximumBytes
    }, 1);
  }
  const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("text/html") || /^\s*</.test(response.bodyText)) {
    throw new CliError("AUTH_REQUIRED", "Garmin returned HTML instead of API JSON", {
      recoveryCommand: "gconnect auth login"
    }, 3);
  }
  try {
    return parseGarminJson(response.bodyText);
  } catch (error) {
    throw new ProtocolChangedError({ issue: "invalid JSON response" }, error);
  }
}

function buildUrl(baseUrl: string, route: string, query: Readonly<Record<string, QueryValue>> | undefined): URL {
  const url = new URL(route, `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin) throw new Error("DI route escaped the configured API origin");
  for (const name of Object.keys(query ?? {}).sort()) {
    const value = query?.[name];
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
  }
  return url;
}

function statusError(response: DiHttpResponse, endpoint: string): CliError {
  return new CliError("GARMIN_REQUEST_FAILED", "Garmin rejected the request", {
    endpoint,
    status: response.status
  }, 1);
}

function mapDiError(error: unknown, endpoint: string): unknown {
  if (!isDiAuthError(error)) return error;
  if (error.code === "DI_RATE_LIMITED") {
    return new CliError("RATE_LIMITED", "Garmin rate-limited authentication", { endpoint }, 5);
  }
  if (error.code === "DI_NETWORK_ERROR" || error.code === "DI_SERVICE_UNAVAILABLE") {
    return new CliError("NETWORK_ERROR", "Unable to connect to Garmin authentication services", {
      endpoint,
      retryable: error.retryable
    }, 1);
  }
  if (
    error.code === "DI_SESSION_REQUIRED" ||
    error.code === "DI_REFRESH_REJECTED" ||
    error.code === "DI_TOKEN_REJECTED"
  ) {
    return new CliError("AUTH_REQUIRED", "Garmin authentication is required", {
      endpoint,
      loginCommand: "gconnect auth login",
      recoveryCommand: "gconnect auth recover"
    }, 3);
  }
  return new CliError(error.code, error.message, { endpoint, ...error.context }, 3);
}

function backoffMilliseconds(attempt: number): number {
  return Math.min(2_000, 200 * (2 ** (attempt - 1)));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new CliError("CANCELLED", "Garmin request was cancelled", {}, 130);
}
