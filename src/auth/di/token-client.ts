import { Buffer } from "node:buffer";
import { isCliError } from "../../core/errors.js";

import type {
  DiHttpClient,
  DiHttpRequest,
  DiHttpResponse,
  DiServiceTicket,
  DiTokenLifecycle,
  DiTokenSet
} from "./contracts.js";
import { PRIVATE_DI_AUTH_BACKEND } from "./contracts.js";
import { DiAuthError, classifyHttpError, isDiAuthError } from "./errors.js";
import { decodeDiTokenResponse, parseJsonBody } from "./protocol.js";

export const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
export const DI_API_BASE_URL = "https://connectapi.garmin.com";
export const DI_SERVICE_TICKET_GRANT =
  "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";

export const DEFAULT_DI_CLIENT_IDS = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI"
] as const;

const NATIVE_HEADERS = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9"
} as const;

export interface DiTokenClientOptions {
  readonly http: DiHttpClient;
  readonly clientIds?: readonly string[];
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export class DiTokenClient implements DiTokenLifecycle {
  readonly #http: DiHttpClient;
  readonly #clientIds: readonly string[];
  readonly #tokenUrl: string;
  readonly #apiBaseUrl: string;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  public constructor(options: DiTokenClientOptions) {
    this.#http = options.http;
    this.#clientIds = [...(options.clientIds ?? DEFAULT_DI_CLIENT_IDS)];
    if (this.#clientIds.length === 0 || this.#clientIds.some((clientId) => clientId.trim() === "")) {
      throw new TypeError("At least one non-empty DI client ID is required");
    }
    this.#tokenUrl = options.tokenUrl ?? DI_TOKEN_URL;
    this.#apiBaseUrl = (options.apiBaseUrl ?? DI_API_BASE_URL).replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  public async exchange(ticket: DiServiceTicket, signal?: AbortSignal): Promise<DiTokenSet> {
    if (ticket.value.trim() === "" || ticket.serviceUrl.trim() === "") {
      throw new TypeError("DI service ticket and service URL must not be empty");
    }
    for (const clientId of this.#clientIds) {
      const response = await this.#postToken(
        "service-ticket exchange",
        clientId,
        {
          client_id: clientId,
          service_ticket: ticket.value,
          grant_type: DI_SERVICE_TICKET_GRANT,
          service_url: ticket.serviceUrl
        },
        signal
      );
      if (response.status === 400 || response.status === 401 || response.status === 403) continue;
      if (response.status < 200 || response.status >= 300) {
        throw classifyHttpError("service-ticket exchange", response.status);
      }
      const decoded = decodeDiTokenResponse(parseJsonBody(response.bodyText, "service-ticket exchange"));
      return this.#toTokenSet(decoded, clientId, null);
    }
    throw new DiAuthError(
      "DI_TOKEN_EXCHANGE_FAILED",
      "Garmin rejected the service ticket for every supported private-DI client",
      { context: { candidateCount: this.#clientIds.length } }
    );
  }

  public async refresh(tokens: DiTokenSet, signal?: AbortSignal): Promise<DiTokenSet> {
    if (tokens.refreshToken === null) {
      throw new DiAuthError("DI_SESSION_REQUIRED", "The Garmin session has no refresh token");
    }
    const response = await this.#postToken(
      "token refresh",
      tokens.clientId,
      {
        grant_type: "refresh_token",
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken
      },
      signal
    );
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new DiAuthError("DI_REFRESH_REJECTED", "Garmin rejected the stored refresh token", {
        status: response.status
      });
    }
    if (response.status < 200 || response.status >= 300) throw classifyHttpError("token refresh", response.status);
    const decoded = decodeDiTokenResponse(parseJsonBody(response.bodyText, "token refresh"));
    return this.#toTokenSet(decoded, tokens.clientId, tokens);
  }

  public async validate(tokens: DiTokenSet, signal?: AbortSignal): Promise<void> {
    const request: DiHttpRequest = {
      method: "GET",
      url: `${this.#apiBaseUrl}/userprofile-service/socialProfile`,
      headers: createDiApiHeaders(tokens.accessToken),
      body: null,
      timeoutMs: this.#timeoutMs,
      signal
    };
    const response = await requestOrNetworkError(this.#http, request, "token validation");
    if (response.status === 401 || response.status === 403) {
      throw new DiAuthError("DI_TOKEN_REJECTED", "Garmin rejected the private-DI access token", {
        status: response.status
      });
    }
    if (response.status < 200 || response.status >= 300) throw classifyHttpError("token validation", response.status);
  }

  async #postToken(
    stage: string,
    clientId: string,
    form: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined
  ): Promise<DiHttpResponse> {
    const request: DiHttpRequest = {
      method: "POST",
      url: this.#tokenUrl,
      headers: {
        ...NATIVE_HEADERS,
        Authorization: `Basic ${Buffer.from(`${clientId}:`, "utf8").toString("base64")}`,
        Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache"
      },
      body: { kind: "form", value: form },
      timeoutMs: this.#timeoutMs,
      signal
    };
    return requestOrNetworkError(this.#http, request, stage);
  }

  #toTokenSet(
    decoded: ReturnType<typeof decodeDiTokenResponse>,
    requestedClientId: string,
    previous: DiTokenSet | null
  ): DiTokenSet {
    const now = this.#now();
    const clientId = extractJwtStringClaim(decoded.accessToken, "client_id") ?? requestedClientId;
    const accessExpiresAtEpochMs = decoded.expiresInSeconds === null
      ? extractJwtExpiry(decoded.accessToken)
      : safeFutureEpoch(now, decoded.expiresInSeconds);
    const refreshToken = decoded.refreshToken ?? previous?.refreshToken ?? null;
    const refreshExpiresAtEpochMs = decoded.refreshExpiresInSeconds === null
      ? previous?.refreshExpiresAtEpochMs ?? null
      : safeFutureEpoch(now, decoded.refreshExpiresInSeconds);
    return {
      backend: PRIVATE_DI_AUTH_BACKEND,
      accessToken: decoded.accessToken,
      refreshToken,
      clientId,
      accessExpiresAtEpochMs,
      refreshExpiresAtEpochMs
    };
  }
}

export function createDiApiHeaders(accessToken: string): Readonly<Record<string, string>> {
  if (accessToken.trim() === "") throw new TypeError("DI access token must not be empty");
  return {
    ...NATIVE_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };
}

async function requestOrNetworkError(
  http: DiHttpClient,
  request: DiHttpRequest,
  stage: string
): Promise<DiHttpResponse> {
  try {
    return await http.request(request);
  } catch (error) {
    if (isDiAuthError(error) || isCliError(error)) throw error;
    throw new DiAuthError("DI_NETWORK_ERROR", `Could not reach Garmin during ${stage}`, {
      retryable: true,
      context: { stage }
    });
  }
}

function safeFutureEpoch(now: number, seconds: number): number {
  const result = now + seconds * 1_000;
  if (!Number.isSafeInteger(result) || result <= now) {
    throw new DiAuthError("DI_PROTOCOL_CHANGED", "Garmin returned an invalid DI token expiration");
  }
  return result;
}

function extractJwtExpiry(token: string): number | null {
  const expiry = extractJwtClaim(token, "exp");
  if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0) return null;
  const milliseconds = expiry * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function extractJwtStringClaim(token: string, name: string): string | null {
  const value = extractJwtClaim(token, name);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function extractJwtClaim(token: string, name: string): unknown {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return (parsed as Readonly<Record<string, unknown>>)[name];
  } catch {
    return null;
  }
}
