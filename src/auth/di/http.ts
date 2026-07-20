import type { DiHttpClient, DiHttpRequest, DiHttpResponse } from "./contracts.js";
import { readTextLimited } from "../../core/response-body.js";

export type DiFetch = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_DI_MAXIMUM_RESPONSE_BYTES = 16_777_216;

export class FetchDiHttpClient implements DiHttpClient {
  readonly #fetch: DiFetch;
  readonly #maximumResponseBytes: number;

  public constructor(
    fetchImplementation: DiFetch = globalThis.fetch,
    maximumResponseBytes = DEFAULT_DI_MAXIMUM_RESPONSE_BYTES
  ) {
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes <= 0) {
      throw new TypeError("maximumResponseBytes must be a positive safe integer");
    }
    this.#fetch = fetchImplementation;
    this.#maximumResponseBytes = maximumResponseBytes;
  }

  public async request(request: DiHttpRequest): Promise<DiHttpResponse> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Garmin request timed out")), request.timeoutMs);
    timeout.unref();
    try {
      const body = encodeBody(request.body);
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
        signal: controller.signal,
        ...(body === undefined ? {} : { body })
      });
      return {
        status: response.status,
        headers: Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
        setCookieHeaders: getSetCookieHeaders(response.headers),
        bodyText: await readTextLimited(response, this.#maximumResponseBytes)
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

function getSetCookieHeaders(headers: Headers): readonly string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") return extended.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function encodeBody(body: DiHttpRequest["body"]): string | undefined {
  if (body === null) return undefined;
  if (body.kind === "json") return JSON.stringify(body.value);
  return new URLSearchParams(body.value).toString();
}
