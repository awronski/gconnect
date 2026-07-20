import type { CookieJar } from "tough-cookie";
import { CliError } from "../../core/errors.js";

export type Fetch = typeof fetch;

export interface CookieFetchOptions {
  readonly fetch: Fetch;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly maximumRedirects?: number;
}

export async function fetchWithCookieJar(
  jar: CookieJar,
  input: string | URL,
  init: RequestInit,
  options: CookieFetchOptions
): Promise<Response> {
  let url = new URL(input);
  const maximumRedirects = options.maximumRedirects ?? 5;
  for (let redirects = 0; ; redirects += 1) {
    if (!options.allowedOrigins.has(url.origin)) {
      throw new CliError("UNSAFE_REDIRECT", "Garmin request attempted to leave an approved origin", {
        origin: url.origin
      }, 1);
    }
    const headers = new Headers(init.headers);
    const cookie = await jar.getCookieString(url.href);
    if (cookie.length > 0) headers.set("Cookie", cookie);
    const response = await options.fetch(url, { ...init, headers, redirect: "manual" });
    for (const setCookie of response.headers.getSetCookie()) {
      await jar.setCookie(setCookie, url.href, { ignoreError: true });
    }
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    if (maximumRedirects === 0) return response;
    if (redirects >= maximumRedirects) {
      throw new CliError("TOO_MANY_REDIRECTS", "Garmin request exceeded the redirect limit", {
        maximumRedirects
      }, 1);
    }
    url = new URL(location, url);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
