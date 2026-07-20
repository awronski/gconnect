export const PRIVATE_DI_AUTH_BACKEND = "private-di" as const;

export interface DiCredentials {
  readonly username: string;
  readonly password: string;
}

export interface DiServiceTicket {
  readonly value: string;
  readonly serviceUrl: string;
}

export interface DiTokenSet {
  readonly backend: typeof PRIVATE_DI_AUTH_BACKEND;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly clientId: string;
  readonly accessExpiresAtEpochMs: number | null;
  readonly refreshExpiresAtEpochMs: number | null;
}

export interface DiMfaChallenge {
  readonly method: string;
  readonly signal: AbortSignal | undefined;
}

export type DiMfaCodePrompt = (challenge: DiMfaChallenge) => Promise<string>;

export interface DiTicketProvider {
  getTicket(credentials: DiCredentials, signal?: AbortSignal): Promise<DiServiceTicket>;
}

export type DiHttpBody =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "form"; readonly value: Readonly<Record<string, string>> };

export interface DiHttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: DiHttpBody | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

export interface DiHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly setCookieHeaders: readonly string[];
  readonly bodyText: string;
}

export interface DiHttpClient {
  request(request: DiHttpRequest): Promise<DiHttpResponse>;
}

export interface DiCookieJar {
  getCookieString(url: string): Promise<string>;
  setCookie(cookie: string, url: string): Promise<unknown>;
}

export interface DiTokenStore {
  load(): Promise<DiTokenSet | null>;
  save(tokens: DiTokenSet): Promise<void>;
  delete(): Promise<void>;
}

export interface DiTokenLifecycle {
  exchange(ticket: DiServiceTicket, signal?: AbortSignal): Promise<DiTokenSet>;
  refresh(tokens: DiTokenSet, signal?: AbortSignal): Promise<DiTokenSet>;
  validate(tokens: DiTokenSet, signal?: AbortSignal): Promise<void>;
}
