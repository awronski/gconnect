import { CliError } from "../../core/errors.js";
import { isRecord } from "../../core/json.js";

export type BrowserCookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface BrowserCookieSnapshot {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: BrowserCookieSameSite;
  readonly expirationDate?: number;
}

export interface BrowserSessionTransferV2 {
  readonly protocolVersion: 2;
  readonly nonce: string;
  readonly source: "browser-companion";
  readonly cookies: readonly BrowserCookieSnapshot[];
}

const TRANSFER_KEYS = new Set(["protocolVersion", "nonce", "source", "cookies"]);
const COOKIE_KEYS = new Set([
  "name",
  "value",
  "domain",
  "hostOnly",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "expirationDate"
]);
const SAME_SITE_VALUES = new Set<BrowserCookieSameSite>([
  "unspecified",
  "no_restriction",
  "lax",
  "strict"
]);
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAXIMUM_COOKIES = 256;
const MAXIMUM_COOKIE_NAME_BYTES = 256;
const MAXIMUM_COOKIE_VALUE_BYTES = 16_384;

export function decodeBrowserSessionTransfer(
  input: unknown,
  expectedNonce: string
): BrowserSessionTransferV2 {
  if (!isRecord(input)) throw invalid("transfer must be an object");
  assertOnlyKeys(input, TRANSFER_KEYS, "transfer");
  if (input.protocolVersion !== 2) throw invalid("unsupported protocolVersion");
  if (input.source !== "browser-companion") throw invalid("source must be browser-companion");
  if (typeof input.nonce !== "string" || input.nonce !== expectedNonce) {
    throw new CliError("RECOVERY_NONCE_MISMATCH", "Recovery nonce did not match", {}, 2);
  }
  if (!Array.isArray(input.cookies) || input.cookies.length === 0 || input.cookies.length > MAXIMUM_COOKIES) {
    throw invalid(`cookies must contain 1..${MAXIMUM_COOKIES} entries`);
  }

  const identities = new Set<string>();
  const cookies = input.cookies.map((value, index) => {
    const cookie = decodeCookie(value, index);
    const identity = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
    if (identities.has(identity)) throw invalid("duplicate cookie identity", index);
    identities.add(identity);
    return cookie;
  });

  return Object.freeze({
    protocolVersion: 2,
    nonce: expectedNonce,
    source: "browser-companion",
    cookies: Object.freeze(cookies)
  });
}

export function cookieDomainAppliesToGarminApplication(domain: string): boolean {
  const canonical = domain.startsWith(".") ? domain.slice(1) : domain;
  return canonical === "connect.garmin.com" || canonical === "garmin.com";
}

export function cookiePathAppliesToGarminApplication(path: string): boolean {
  const requestPath = "/app/home";
  if (!path.startsWith("/")) return false;
  if (path === requestPath) return true;
  if (!requestPath.startsWith(path)) return false;
  return path.endsWith("/") || requestPath[path.length] === "/";
}

function decodeCookie(input: unknown, index: number): BrowserCookieSnapshot {
  if (!isRecord(input)) throw invalid("cookie must be an object", index);
  assertOnlyKeys(input, COOKIE_KEYS, "cookie", index);

  const name = requiredString(input.name, "name", index);
  if (!COOKIE_NAME.test(name) || Buffer.byteLength(name) > MAXIMUM_COOKIE_NAME_BYTES) {
    throw invalid("cookie name is invalid", index);
  }
  const value = requiredString(input.value, "value", index);
  if (
    Buffer.byteLength(value) > MAXIMUM_COOKIE_VALUE_BYTES
    || /[\u0000-\u001f\u007f;]/.test(value)
  ) {
    throw invalid("cookie value is invalid", index);
  }

  const domain = requiredString(input.domain, "domain", index).toLowerCase();
  if (!cookieDomainAppliesToGarminApplication(domain)) {
    throw invalid("cookie domain does not apply to connect.garmin.com", index);
  }
  if (typeof input.hostOnly !== "boolean") {
    throw invalid("cookie hostOnly must be boolean", index);
  }
  if (input.hostOnly && domain !== "connect.garmin.com") {
    throw invalid("host-only cookie domain must equal connect.garmin.com", index);
  }
  const path = requiredString(input.path, "path", index);
  if (!cookiePathAppliesToGarminApplication(path)) {
    throw invalid("cookie path does not apply to /app/home", index);
  }
  if (typeof input.secure !== "boolean" || typeof input.httpOnly !== "boolean") {
    throw invalid("cookie secure and httpOnly must be boolean", index);
  }
  if (typeof input.sameSite !== "string" || !SAME_SITE_VALUES.has(input.sameSite as BrowserCookieSameSite)) {
    throw invalid("cookie sameSite is invalid", index);
  }
  const expirationDate = input.expirationDate;
  if (
    expirationDate !== undefined
    && (typeof expirationDate !== "number" || !Number.isFinite(expirationDate) || expirationDate <= 0)
  ) {
    throw invalid("cookie expirationDate is invalid", index);
  }

  return Object.freeze({
    name,
    value,
    domain,
    hostOnly: input.hostOnly,
    path,
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: input.sameSite as BrowserCookieSameSite,
    ...(expirationDate === undefined ? {} : { expirationDate })
  });
}

function assertOnlyKeys(
  input: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
  index?: number
): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw invalid(`${label} contains an unknown field`, index);
  }
}

function requiredString(input: unknown, field: string, index: number): string {
  if (typeof input !== "string" || input.length === 0) {
    throw invalid(`cookie ${field} is invalid`, index);
  }
  return input;
}

function invalid(issue: string, cookieIndex?: number): CliError {
  return new CliError(
    "INVALID_RECOVERY_TRANSFER",
    "Browser companion sent an invalid session transfer",
    {
      issue,
      ...(cookieIndex === undefined ? {} : { cookieIndex })
    },
    2
  );
}
