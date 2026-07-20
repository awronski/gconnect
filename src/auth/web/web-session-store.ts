import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import { expectArray, expectNumber, expectRecord, expectString } from "../../core/json.js";
import { SecureJsonFile } from "../../storage/secure-json-file.js";

interface StoredWebSessionV1 {
  readonly schemaVersion: 1;
  readonly backend: "web-cookie";
  readonly savedAt: string;
  readonly cookieJar: SerializedCookieJar;
}

export interface WebSessionStore {
  load(): Promise<CookieJar | null>;
  save(cookieJar: CookieJar): Promise<void>;
  delete(): Promise<void>;
  path(): string;
}

export class FileWebSessionStore implements WebSessionStore {
  readonly #file: SecureJsonFile<StoredWebSessionV1>;

  public constructor(path: string) {
    this.#file = new SecureJsonFile(path, decodeStoredWebSession);
  }

  public async load(): Promise<CookieJar | null> {
    const stored = await this.#file.load();
    return stored === null ? null : CookieJar.deserialize(stored.cookieJar);
  }

  public async save(cookieJar: CookieJar): Promise<void> {
    await this.#file.save({
      schemaVersion: 1,
      backend: "web-cookie",
      savedAt: new Date().toISOString(),
      cookieJar: await cookieJar.serialize()
    });
  }

  public delete(): Promise<void> {
    return this.#file.delete();
  }

  public path(): string {
    return this.#file.path();
  }
}

function decodeStoredWebSession(input: unknown): StoredWebSessionV1 {
  const record = expectRecord(input, "web session");
  if (expectNumber(record.schemaVersion, "web session.schemaVersion") !== 1) {
    throw new TypeError("web session schemaVersion must be 1");
  }
  if (expectString(record.backend, "web session.backend") !== "web-cookie") {
    throw new TypeError("web session backend must be web-cookie");
  }
  const savedAt = expectString(record.savedAt, "web session.savedAt");
  if (Number.isNaN(Date.parse(savedAt))) throw new TypeError("web session.savedAt must be an ISO timestamp");
  const jar = expectRecord(record.cookieJar, "web session.cookieJar");
  expectString(jar.version, "web session.cookieJar.version");
  if (jar.storeType !== null && typeof jar.storeType !== "string") {
    throw new TypeError("web session.cookieJar.storeType must be a string or null");
  }
  if (typeof jar.rejectPublicSuffixes !== "boolean") {
    throw new TypeError("web session.cookieJar.rejectPublicSuffixes must be boolean");
  }
  const cookies = expectArray(jar.cookies, "web session.cookieJar.cookies");
  if (cookies.length === 0) throw new TypeError("web session.cookieJar.cookies cannot be empty");
  cookies.forEach(validateSerializedCookie);
  const serialized = jar as unknown as SerializedCookieJar;
  const roundTrip = CookieJar.deserializeSync(serialized).serializeSync();
  if (roundTrip === undefined || roundTrip.cookies.length !== cookies.length) {
    throw new TypeError("web session.cookieJar contains cookies that cannot be deserialized");
  }
  return {
    schemaVersion: 1,
    backend: "web-cookie",
    savedAt,
    cookieJar: serialized
  };
}

function validateSerializedCookie(input: unknown, index: number): void {
  const name = `web session.cookieJar.cookies[${index}]`;
  const cookie = expectRecord(input, name);
  if (expectString(cookie.key, `${name}.key`).length === 0) throw new TypeError(`${name}.key cannot be empty`);
  expectString(cookie.value, `${name}.value`);
  const domain = expectString(cookie.domain, `${name}.domain`).toLowerCase().replace(/^\./, "");
  if (domain !== "garmin.com" && !domain.endsWith(".garmin.com")) {
    throw new TypeError(`${name}.domain must be Garmin-owned`);
  }
  if (!expectString(cookie.path, `${name}.path`).startsWith("/")) {
    throw new TypeError(`${name}.path must be absolute`);
  }
  for (const field of ["secure", "httpOnly", "hostOnly", "pathIsDefault"] as const) {
    if (cookie[field] !== undefined && typeof cookie[field] !== "boolean") {
      throw new TypeError(`${name}.${field} must be boolean`);
    }
  }
  if (cookie.sameSite !== undefined && !["lax", "strict", "none"].includes(String(cookie.sameSite))) {
    throw new TypeError(`${name}.sameSite is invalid`);
  }
  for (const field of ["creation", "lastAccessed"] as const) {
    if (cookie[field] !== undefined) validateCookieDate(cookie[field], `${name}.${field}`);
  }
  if (cookie.expires !== undefined && cookie.expires !== null && cookie.expires !== "Infinity") {
    validateCookieDate(cookie.expires, `${name}.expires`);
  }
  if (
    cookie.maxAge !== undefined
    && cookie.maxAge !== null
    && cookie.maxAge !== "Infinity"
    && cookie.maxAge !== "-Infinity"
    && (typeof cookie.maxAge !== "number" || !Number.isFinite(cookie.maxAge))
  ) {
    throw new TypeError(`${name}.maxAge is invalid`);
  }
  if (cookie.extensions !== undefined) {
    const extensions = expectArray(cookie.extensions, `${name}.extensions`);
    if (extensions.some((value) => typeof value !== "string")) throw new TypeError(`${name}.extensions must contain strings`);
  }
}

function validateCookieDate(value: unknown, name: string): void {
  const text = expectString(value, name);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${name} must be an ISO date`);
}
