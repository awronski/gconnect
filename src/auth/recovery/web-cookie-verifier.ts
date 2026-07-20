import { Cookie, CookieJar } from "tough-cookie";
import { CliError } from "../../core/errors.js";
import { expectRecord } from "../../core/json.js";
import { WebGarminDownloadService } from "../../download/web-garmin-download-service.js";
import { StoredWebSessionManager } from "../web/web-session-manager.js";
import type { WebSessionStore } from "../web/web-session-store.js";
import type { BrowserSessionTransferV2 } from "./companion-protocol.js";

type RecoveryVerificationStage = "cookie-import" | "home-bootstrap" | "user-settings-probe";

export interface WebCookieRecoveryVerifierOptions {
  readonly store: WebSessionStore;
  readonly fetch: typeof fetch;
  readonly applicationOrigin?: string;
}

export interface PreparedWebRecovery {
  readonly profileId: string;
  commit(): Promise<void>;
}

export class WebCookieRecoveryVerifier {
  readonly #store: WebSessionStore;
  readonly #fetch: typeof fetch;
  readonly #applicationOrigin: string;

  public constructor(options: WebCookieRecoveryVerifierOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#applicationOrigin = options.applicationOrigin ?? "https://connect.garmin.com";
  }

  public async prepare(
    transfer: BrowserSessionTransferV2,
    signal: AbortSignal
  ): Promise<PreparedWebRecovery> {
    if (signal.aborted) throw signal.reason;
    const provisionalJar = await runVerificationStage(
      "cookie-import",
      signal,
      () => buildCookieJar(transfer)
    );
    const provisionalStore = new MemoryWebSessionStore(provisionalJar);
    const sessions = new StoredWebSessionManager({
      store: provisionalStore,
      fetch: this.#fetch,
      applicationOrigin: this.#applicationOrigin
    });
    const session = await runVerificationStage(
      "home-bootstrap",
      signal,
      () => sessions.session(true, signal)
    );
    if (signal.aborted) throw signal.reason;
    const probe = new WebGarminDownloadService({
      sessions,
      fetch: this.#fetch,
      origin: this.#applicationOrigin,
      maximumAttempts: 1
    });
    await runVerificationStage("user-settings-probe", signal, () => probe.json({
      path: "/gc-api/userprofile-service/userprofile/user-settings/",
      signal,
      decode: (input) => expectRecord(input, "user settings probe")
    }));
    if (signal.aborted) throw signal.reason;
    let commitPromise: Promise<void> | null = null;
    return Object.freeze({
      profileId: session.profileId,
      commit: (): Promise<void> => {
        commitPromise ??= this.#store.save(provisionalJar);
        return commitPromise;
      }
    });
  }
}

async function buildCookieJar(transfer: BrowserSessionTransferV2): Promise<CookieJar> {
  const jar = new CookieJar();
  const applicationUrl = "https://connect.garmin.com/app/home";
  for (const snapshot of transfer.cookies) {
    const cookie = new Cookie({
      key: snapshot.name,
      value: snapshot.value,
      ...(snapshot.hostOnly
        ? {}
        : { domain: snapshot.domain.startsWith(".") ? snapshot.domain.slice(1) : snapshot.domain }),
      path: snapshot.path,
      secure: snapshot.secure,
      httpOnly: snapshot.httpOnly,
      ...(snapshot.sameSite === "unspecified"
        ? {}
        : { sameSite: snapshot.sameSite === "no_restriction" ? "none" : snapshot.sameSite }),
      ...(snapshot.expirationDate === undefined ? {} : { expires: new Date(snapshot.expirationDate * 1_000) })
    });
    const imported = await jar.setCookie(cookie, applicationUrl, { ignoreError: false });
    if (imported === undefined) throw new TypeError("Browser cookie import was rejected");
  }
  if ((await jar.getCookies(applicationUrl)).length === 0) {
    throw new TypeError("Browser transfer did not contain a currently applicable Garmin cookie");
  }
  return jar;
}

async function runVerificationStage<T>(
  stage: RecoveryVerificationStage,
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    const reasonCode = cause instanceof CliError
      ? cause.code
      : stage === "cookie-import"
        ? "INVALID_COOKIE"
        : "INTERNAL_ERROR";
    const status = cause instanceof CliError ? safeStatus(cause.details.status) : undefined;
    throw new CliError(
      "AUTH_RECOVERY_VERIFICATION_FAILED",
      "Garmin browser session verification failed",
      { stage, reasonCode, ...(status === undefined ? {} : { status }) },
      cause instanceof CliError ? cause.exitCode : 3
    );
  }
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

class MemoryWebSessionStore implements WebSessionStore {
  #jar: CookieJar | null;

  public constructor(jar: CookieJar) {
    this.#jar = jar;
  }

  public async load(): Promise<CookieJar | null> {
    return this.#jar;
  }

  public async save(cookieJar: CookieJar): Promise<void> {
    this.#jar = cookieJar;
  }

  public async delete(): Promise<void> {
    this.#jar = null;
  }

  public path(): string {
    return "[memory]";
  }
}
