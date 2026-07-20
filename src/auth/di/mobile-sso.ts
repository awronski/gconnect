import { CookieJar } from "tough-cookie";
import { isCliError } from "../../core/errors.js";

import type {
  DiCookieJar,
  DiCredentials,
  DiHttpClient,
  DiHttpRequest,
  DiHttpResponse,
  DiMfaCodePrompt,
  DiServiceTicket
} from "./contracts.js";
import { DiAuthError, classifyHttpError, isDiAuthError } from "./errors.js";
import {
  decodeMfaVerificationResponse,
  decodeMobileLoginResponse,
  parseJsonBody,
  responseContainsRateLimit
} from "./protocol.js";

export const MOBILE_SSO_LOGIN_URL = "https://sso.garmin.com/mobile/api/login";
export const MOBILE_SSO_MFA_URL = "https://sso.garmin.com/mobile/api/mfa/verifyCode";
export const MOBILE_SSO_CLIENT_ID = "GCM_IOS_DARK";
export const MOBILE_SSO_SERVICE_URL = "https://mobile.integration.garmin.com/gcm/ios";

const IOS_LOGIN_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

export interface MobileSsoOptions {
  readonly http: DiHttpClient;
  readonly promptMfaCode?: DiMfaCodePrompt;
  readonly loginUrl?: string;
  readonly mfaUrl?: string;
  readonly clientId?: string;
  readonly serviceUrl?: string;
  readonly locale?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly cookieJar?: DiCookieJar;
}

export class MobileSsoTicketProvider {
  readonly #http: DiHttpClient;
  readonly #promptMfaCode: DiMfaCodePrompt | null;
  readonly #loginUrl: string;
  readonly #mfaUrl: string;
  readonly #clientId: string;
  readonly #serviceUrl: string;
  readonly #locale: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #cookieJar: DiCookieJar;

  public constructor(options: MobileSsoOptions) {
    this.#http = options.http;
    this.#promptMfaCode = options.promptMfaCode ?? null;
    this.#loginUrl = options.loginUrl ?? MOBILE_SSO_LOGIN_URL;
    this.#mfaUrl = options.mfaUrl ?? MOBILE_SSO_MFA_URL;
    this.#clientId = options.clientId ?? MOBILE_SSO_CLIENT_ID;
    this.#serviceUrl = options.serviceUrl ?? MOBILE_SSO_SERVICE_URL;
    this.#locale = options.locale ?? "en-US";
    this.#userAgent = options.userAgent ?? IOS_LOGIN_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#cookieJar = options.cookieJar ?? new CookieJar();
  }

  public async getTicket(credentials: DiCredentials, signal?: AbortSignal): Promise<DiServiceTicket> {
    if (credentials.username.trim() === "" || credentials.password === "") {
      throw new DiAuthError("DI_INVALID_CREDENTIALS", "Garmin username and password are required");
    }

    const response = await this.#requestJson(
      "mobile login",
      this.#loginUrl,
      {
        username: credentials.username,
        password: credentials.password,
        rememberMe: true,
        captchaToken: ""
      },
      signal
    );
    const result = decodeMobileLoginResponse(response);
    switch (result.kind) {
      case "success":
        return { value: result.serviceTicketId, serviceUrl: this.#serviceUrl };
      case "invalid-credentials":
        throw new DiAuthError("DI_INVALID_CREDENTIALS", "Garmin rejected the username or password");
      case "captcha-required":
        throw new DiAuthError(
          "DI_CAPTCHA_REQUIRED",
          "Garmin requires an interactive CAPTCHA before private-DI login can continue"
        );
      case "mfa-required":
        return this.#completeMfa(result.method, signal);
    }
  }

  async #completeMfa(method: string, signal: AbortSignal | undefined): Promise<DiServiceTicket> {
    if (this.#promptMfaCode === null) {
      throw new DiAuthError("DI_MFA_REQUIRED", "Garmin multi-factor authentication is required", {
        context: { method }
      });
    }
    const code = (await this.#promptMfaCode({ method, signal })).trim();
    if (code === "") {
      throw new DiAuthError("DI_MFA_REJECTED", "Garmin MFA code must not be empty", {
        context: { method }
      });
    }

    const response = await this.#requestJson(
      "MFA verification",
      this.#mfaUrl,
      {
        mfaMethod: method,
        mfaVerificationCode: code,
        rememberMyBrowser: true,
        reconsentList: [],
        mfaSetup: false
      },
      signal
    );
    const result = decodeMfaVerificationResponse(response);
    if (result.kind === "rejected") {
      if (result.responseType === "CAPTCHA_REQUIRED") {
        throw new DiAuthError(
          "DI_CAPTCHA_REQUIRED",
          "Garmin requires an interactive CAPTCHA before MFA can continue"
        );
      }
      throw new DiAuthError("DI_MFA_REJECTED", "Garmin rejected the MFA verification", {
        context: { method }
      });
    }
    return { value: result.serviceTicketId, serviceUrl: this.#serviceUrl };
  }

  async #requestJson(
    stage: string,
    endpoint: string,
    value: unknown,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const url = new URL(endpoint);
    url.searchParams.set("clientId", this.#clientId);
    url.searchParams.set("locale", this.#locale);
    url.searchParams.set("service", this.#serviceUrl);
    const request: DiHttpRequest = {
      method: "POST",
      url: url.toString(),
      headers: {
        "User-Agent": this.#userAgent,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Origin: url.origin,
        ...(await this.#cookieHeader(url.toString()))
      },
      body: { kind: "json", value },
      timeoutMs: this.#timeoutMs,
      signal
    };
    const response = await requestOrNetworkError(this.#http, request, stage);
    await this.#rememberCookies(url.toString(), response.setCookieHeaders, stage);
    if (response.status === 429) throw classifyHttpError(stage, response.status);
    if (response.status === 403) {
      throw new DiAuthError("DI_BOT_CHALLENGE", `Garmin blocked ${stage} with a browser challenge`, {
        status: response.status
      });
    }
    if (response.status >= 500) throw classifyHttpError(stage, response.status);
    if (looksLikeHtml(response)) {
      throw new DiAuthError("DI_BOT_CHALLENGE", `Garmin returned a browser challenge during ${stage}`, {
        status: response.status
      });
    }
    const decoded = parseJsonBody(response.bodyText, stage);
    if (responseContainsRateLimit(decoded)) throw classifyHttpError(stage, 429);
    return decoded;
  }

  async #cookieHeader(url: string): Promise<Readonly<Record<string, string>>> {
    const value = await this.#cookieJar.getCookieString(url);
    return value === "" ? {} : { Cookie: value };
  }

  async #rememberCookies(url: string, cookies: readonly string[], stage: string): Promise<void> {
    try {
      for (const cookie of cookies) await this.#cookieJar.setCookie(cookie, url);
    } catch {
      throw new DiAuthError("DI_PROTOCOL_CHANGED", `Garmin returned an invalid SSO cookie during ${stage}`, {
        context: { stage }
      });
    }
  }
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

function looksLikeHtml(response: DiHttpResponse): boolean {
  const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
  const prefix = response.bodyText.trimStart().slice(0, 32).toLowerCase();
  return contentType.includes("text/html") || prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}
