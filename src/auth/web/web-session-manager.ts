import type { CookieJar } from "tough-cookie";
import type { AuthStateCoordinator } from "../auth-state.js";
import { CliError, isCliError } from "../../core/errors.js";
import { readTextLimited } from "../../core/response-body.js";
import { fetchWithCookieJar, type Fetch } from "./cookie-fetch.js";
import type { WebSessionStore } from "./web-session-store.js";

export interface WebAuthenticatedSession {
  readonly cookieJar: CookieJar;
  readonly csrfToken: string;
  readonly profileId: string;
}

export interface WebSessionManager {
  session(forceBootstrap?: boolean, signal?: AbortSignal): Promise<WebAuthenticatedSession>;
  persist(): Promise<void>;
  disconnect(): Promise<void>;
  hasStoredSession(): Promise<boolean>;
}

export interface WebSessionManagerOptions {
  readonly store: WebSessionStore;
  readonly fetch: Fetch;
  readonly applicationOrigin?: string;
  readonly bootstrapTimeoutMs?: number;
  readonly authState?: Pick<AuthStateCoordinator, "activeState" | "runExclusive">;
}

export class StoredWebSessionManager implements WebSessionManager {
  readonly #store: WebSessionStore;
  readonly #fetch: Fetch;
  readonly #applicationOrigin: string;
  readonly #bootstrapTimeoutMs: number;
  readonly #authState: Pick<AuthStateCoordinator, "activeState" | "runExclusive"> | null;
  #current: WebAuthenticatedSession | null = null;
  #bootstrap: {
    readonly revision: string | null;
    readonly promise: Promise<WebAuthenticatedSession>;
  } | null = null;
  #persistQueue: Promise<void> = Promise.resolve();
  #activeRevision: string | null = null;

  public constructor(options: WebSessionManagerOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#applicationOrigin = options.applicationOrigin ?? "https://connect.garmin.com";
    this.#authState = options.authState ?? null;
    this.#bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#bootstrapTimeoutMs) || this.#bootstrapTimeoutMs < 1) {
      throw new TypeError("bootstrapTimeoutMs must be a positive safe integer");
    }
  }

  public async session(forceBootstrap = false, signal?: AbortSignal): Promise<WebAuthenticatedSession> {
    throwIfAborted(signal);
    let revision: string | null = null;
    if (this.#authState !== null) {
      const active = await this.#authState.activeState();
      if (active?.backend !== "web-cookie") throw inactiveWebSession();
      revision = active.revision;
      if (this.#activeRevision !== null && this.#activeRevision !== active.revision) {
        this.#current = null;
        this.#activeRevision = null;
      }
    }
    if (!forceBootstrap && this.#current !== null) return this.#current;
    if (this.#bootstrap !== null) {
      if (this.#bootstrap.revision === revision) return this.#bootstrap.promise;
      await this.#bootstrap.promise.catch(() => undefined);
      throwIfAborted(signal);
      return this.session(forceBootstrap, signal);
    }
    this.#activeRevision = revision;
    const promise = this.#loadAndBootstrap(signal, revision);
    this.#bootstrap = { revision, promise };
    try {
      this.#current = await promise;
      return this.#current;
    } finally {
      if (this.#bootstrap?.promise === promise) this.#bootstrap = null;
    }
  }

  public async persist(): Promise<void> {
    if (this.#current !== null) await this.#queueSave(this.#current.cookieJar);
  }

  public async disconnect(): Promise<void> {
    this.#current = null;
    this.#activeRevision = null;
    await this.#store.delete();
  }

  public async hasStoredSession(): Promise<boolean> {
    return (await this.#store.load()) !== null;
  }

  async #loadAndBootstrap(signal: AbortSignal | undefined, revision: string | null): Promise<WebAuthenticatedSession> {
    const jar = this.#current?.cookieJar ?? await this.#store.load();
    if (jar === null) {
      throw new CliError("AUTH_REQUIRED", "No Garmin browser session is stored", {
        recoveryCommand: "gconnect auth recover"
      }, 3);
    }
    const home = new URL("/app/home", this.#applicationOrigin);
    const timeout = referencedTimeoutSignal(this.#bootstrapTimeoutMs);
    const requestSignal = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
    let response: Response;
    try {
      response = await fetchWithCookieJar(jar, home, {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "gconnect-cli/0.1"
        },
        signal: requestSignal
      }, {
        fetch: this.#fetch,
        allowedOrigins: new Set([new URL(this.#applicationOrigin).origin, "https://sso.garmin.com"])
      });
    } catch (error) {
      timeout.cancel();
      throwIfAborted(signal);
      if (isCliError(error)) throw error;
      throw new CliError("NETWORK_ERROR", "Unable to bootstrap the Garmin browser session", {
        retryable: true,
        timeoutMs: this.#bootstrapTimeoutMs,
        reason: error instanceof Error ? error.message : String(error)
      }, 1);
    }
    let html: string;
    try {
      html = await readTextLimited(response, 4_194_304);
    } catch (error) {
      timeout.cancel();
      throwIfAborted(signal);
      if (isCliError(error)) throw error;
      throw new CliError("NETWORK_ERROR", "Unable to read the Garmin browser bootstrap response", {
        retryable: true,
        timeoutMs: this.#bootstrapTimeoutMs,
        reason: error instanceof Error ? error.message : String(error)
      }, 1);
    }
    timeout.cancel();
    if (!response.ok || !/viewerIsAuthenticated\s*=\s*true/.test(html)) {
      throw new CliError("AUTH_REQUIRED", "The saved Garmin browser session is expired or invalid", {
        recoveryCommand: "gconnect auth recover",
        status: response.status
      }, 3);
    }
    const csrfToken = extractCsrfToken(html);
    const profileId = extractProfileId(html);
    const session = { cookieJar: jar, csrfToken, profileId };
    await this.#queueSave(jar, revision);
    return session;
  }

  #queueSave(jar: CookieJar, revision = this.#activeRevision): Promise<void> {
    const save = this.#persistQueue.then(async () => {
      if (this.#authState === null) {
        await this.#store.save(jar);
        return;
      }
      await this.#authState.runExclusive(async () => {
        const active = await this.#authState?.activeState();
        if (active?.backend !== "web-cookie" || active.revision !== revision) throw inactiveWebSession();
        await this.#store.save(jar);
      });
    });
    this.#persistQueue = save.catch(() => undefined);
    return save;
  }
}

function referencedTimeoutSignal(milliseconds: number): { readonly signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Garmin browser bootstrap timed out after ${milliseconds}ms`));
  }, milliseconds);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new CliError("CANCELLED", "Garmin request was cancelled", {}, 130);
}

function inactiveWebSession(): CliError {
  return new CliError("AUTH_STATE_CHANGED", "The active Garmin authentication session changed", {
    retryable: true
  }, 1);
}

function extractCsrfToken(html: string): string {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (!/\bname\s*=\s*["']csrf-token["']/i.test(tag)) continue;
    const match = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (match?.[1] !== undefined && match[1].length > 0) return decodeBasicHtmlEntities(match[1]);
  }
  throw new CliError("PROTOCOL_CHANGED", "Authenticated Garmin HTML did not contain a CSRF token", {
    component: "web-session-bootstrap"
  }, 1);
}

function extractProfileId(html: string): string {
  const assignment = /VIEWER_USERPREFERENCES[\s\S]{0,4096}?displayName["']?\s*:\s*["']([^"']+)["']/i.exec(html);
  const profileId = assignment?.[1];
  if (profileId === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(profileId)) {
    throw new CliError("PROTOCOL_CHANGED", "Authenticated Garmin HTML did not contain a valid profile id", {
      component: "web-session-bootstrap"
    }, 1);
  }
  return profileId;
}

function decodeBasicHtmlEntities(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
