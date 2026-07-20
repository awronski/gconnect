import type { PrivateDiAuthenticator } from "./di/authenticator.js";
import type { DiTokenSet, DiTokenStore } from "./di/contracts.js";
import { isDiAuthError } from "./di/errors.js";
import type { DiSessionManager } from "./di/session-manager.js";
import type { DiTokenClient } from "./di/token-client.js";
import type { WebSessionManager } from "./web/web-session-manager.js";
import { CliError } from "../core/errors.js";
import type { AuthInput } from "./auth-input.js";
import type { AuthStateCoordinator } from "./auth-state.js";

export interface AuthStatus {
  readonly connected: boolean;
  readonly backend: "private-di" | "web-cookie" | null;
  readonly verified: boolean | null;
  readonly accessExpiresAt: string | null;
  readonly refreshExpiresAt: string | null;
}

export interface AuthRecoveryRequest {
  readonly timeoutMs: number;
  readonly openBrowser: boolean;
}

export interface PreparedAuthRecovery {
  readonly mechanism: string;
  commit(): Promise<void>;
}

export interface AuthRecoveryRunner {
  recover(request: AuthRecoveryRequest): Promise<PreparedAuthRecovery>;
}

export interface AuthService {
  login(options: { readonly username?: string; readonly passwordStdin: boolean }): Promise<AuthStatus>;
  status(verify: boolean): Promise<AuthStatus>;
  recover(request: AuthRecoveryRequest): Promise<{ readonly mechanism: string }>;
  disconnect(): Promise<void>;
}

export interface GarminAuthServiceOptions {
  readonly input: AuthInput;
  readonly authenticator: (passwordStdin: boolean) => PrivateDiAuthenticator;
  readonly diStore: DiTokenStore;
  readonly diSessions: DiSessionManager;
  readonly diTokens: DiTokenClient;
  readonly webSessions: WebSessionManager;
  readonly authState: AuthStateCoordinator;
  readonly recovery?: AuthRecoveryRunner;
  readonly onBackendChanged?: () => void;
}

export class GarminAuthService implements AuthService {
  readonly #input: AuthInput;
  readonly #authenticator: (passwordStdin: boolean) => PrivateDiAuthenticator;
  readonly #diStore: DiTokenStore;
  readonly #diSessions: DiSessionManager;
  readonly #diTokens: DiTokenClient;
  readonly #webSessions: WebSessionManager;
  readonly #authState: AuthStateCoordinator;
  readonly #recovery: AuthRecoveryRunner | null;
  readonly #onBackendChanged: () => void;

  public constructor(options: GarminAuthServiceOptions) {
    this.#input = options.input;
    this.#authenticator = options.authenticator;
    this.#diStore = options.diStore;
    this.#diSessions = options.diSessions;
    this.#diTokens = options.diTokens;
    this.#webSessions = options.webSessions;
    this.#authState = options.authState;
    this.#recovery = options.recovery ?? null;
    this.#onBackendChanged = options.onBackendChanged ?? (() => undefined);
  }

  public async login(options: { readonly username?: string; readonly passwordStdin: boolean }): Promise<AuthStatus> {
    const username = await this.#input.readUsername(options.username);
    const password = await this.#input.readPassword(options.passwordStdin);
    try {
      const tokens = await this.#authenticator(options.passwordStdin).authenticate({ username, password });
      let committed = false;
      let credentialCleanupCompleted = false;
      try {
        await this.#authState.runExclusive(async () => {
          await this.#diStore.save(tokens);
          await this.#authState.setActiveBackend("private-di");
          committed = true;
          await this.#webSessions.disconnect();
          credentialCleanupCompleted = true;
        });
      } catch (error) {
        if (committed) throw committedTransitionFailure("private-di", credentialCleanupCompleted, error);
        throw error;
      } finally {
        if (committed) this.#onBackendChanged();
      }
      return tokenStatus(tokens, true);
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  public async status(verify: boolean): Promise<AuthStatus> {
    const backend = await this.#authState.activeBackend();
    if (backend === "private-di") {
      const tokens = await this.#diStore.load();
      if (tokens === null) throw corruptAuthState("private-di");
      if (verify) {
        try {
          const valid = await this.#diSessions.getValidSession();
          await this.#diTokens.validate(valid);
          return tokenStatus(valid, true);
        } catch (error) {
          throw mapAuthError(error);
        }
      }
      return tokenStatus(tokens, null);
    }
    if (backend === "web-cookie") {
      if (!await this.#webSessions.hasStoredSession()) throw corruptAuthState("web-cookie");
      if (verify) {
        try {
          await this.#webSessions.session(true);
        } catch (error) {
          throw mapAuthError(error);
        }
      }
      return {
        connected: true,
        backend: "web-cookie",
        verified: verify ? true : null,
        accessExpiresAt: null,
        refreshExpiresAt: null
      };
    }
    return {
      connected: false,
      backend: null,
      verified: verify ? false : null,
      accessExpiresAt: null,
      refreshExpiresAt: null
    };
  }

  public async recover(request: AuthRecoveryRequest): Promise<{ readonly mechanism: string }> {
    const recovery = this.#recovery;
    if (recovery === null) {
      throw new CliError("AUTH_RECOVERY_UNAVAILABLE", "Browser-assisted recovery is not installed in this build", {}, 3);
    }
    const expectedState = await this.#authState.activeState();
    const prepared = await recovery.recover(request);
    let committed = false;
    let credentialCleanupCompleted = false;
    try {
      await this.#authState.runExclusive(async () => {
        const currentState = await this.#authState.activeState();
        if (!sameAuthState(expectedState, currentState)) {
          throw new CliError(
            "AUTH_STATE_CHANGED",
            "Authentication state changed while browser recovery was in progress",
            { retryable: true },
            1
          );
        }
        await prepared.commit();
        await this.#authState.setActiveBackend("web-cookie");
        committed = true;
        await this.#diStore.delete();
        credentialCleanupCompleted = true;
      });
      return { mechanism: prepared.mechanism };
    } catch (error) {
      if (committed) throw committedTransitionFailure("web-cookie", credentialCleanupCompleted, error);
      throw error;
    } finally {
      if (committed) this.#onBackendChanged();
    }
  }

  public async disconnect(): Promise<void> {
    let committed = false;
    let credentialCleanupCompleted = false;
    try {
      await this.#authState.runExclusive(async () => {
        await this.#authState.clearActiveBackend();
        committed = true;
        await Promise.all([this.#diStore.delete(), this.#webSessions.disconnect()]);
        credentialCleanupCompleted = true;
      });
    } catch (error) {
      if (committed) throw committedTransitionFailure(null, credentialCleanupCompleted, error);
      throw error;
    } finally {
      if (committed) this.#onBackendChanged();
    }
  }
}

function sameAuthState(
  left: Awaited<ReturnType<AuthStateCoordinator["activeState"]>>,
  right: Awaited<ReturnType<AuthStateCoordinator["activeState"]>>
): boolean {
  if (left === null || right === null) return left === right;
  return left.backend === right.backend && left.revision === right.revision;
}

function committedTransitionFailure(
  activeBackend: AuthStatus["backend"],
  credentialCleanupCompleted: boolean,
  cause: unknown
): CliError {
  const error = new CliError(
    "AUTH_TRANSITION_FINALIZATION_FAILED",
    "Authentication state was committed, but transition finalization did not complete",
    {
      transitionCommitted: true,
      activeBackend,
      credentialCleanupCompleted,
      credentialsMayRemain: !credentialCleanupCompleted,
      nextCommand: credentialCleanupCompleted ? "gconnect auth status" : "gconnect auth disconnect",
      retryable: true
    },
    1
  );
  error.cause = cause;
  return error;
}

function corruptAuthState(backend: "private-di" | "web-cookie"): CliError {
  return new CliError("AUTH_STATE_CORRUPT", "The active Garmin authentication backend has no credential file", {
    backend,
    disconnectCommand: "gconnect auth disconnect"
  }, 1);
}

function tokenStatus(tokens: DiTokenSet, verified: boolean | null): AuthStatus {
  return {
    connected: true,
    backend: "private-di",
    verified,
    accessExpiresAt: epochToIso(tokens.accessExpiresAtEpochMs),
    refreshExpiresAt: epochToIso(tokens.refreshExpiresAtEpochMs)
  };
}

function epochToIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function mapAuthError(error: unknown): unknown {
  if (!isDiAuthError(error)) return error;
  switch (error.code) {
    case "DI_INVALID_CREDENTIALS":
      return new CliError("AUTH_INVALID_CREDENTIALS", "Garmin rejected the username or password", {}, 3);
    case "DI_MFA_REQUIRED":
    case "DI_MFA_REJECTED":
      return new CliError(error.code, error.message, error.context, 3);
    case "DI_CAPTCHA_REQUIRED":
    case "DI_BOT_CHALLENGE":
      return new CliError("AUTH_BROWSER_RECOVERY_REQUIRED", error.message, {
        recoveryCommand: "gconnect auth recover"
      }, 3);
    case "DI_RATE_LIMITED":
      return new CliError("RATE_LIMITED", "Garmin rate-limited authentication", { retryable: true }, 5);
    case "DI_NETWORK_ERROR":
    case "DI_SERVICE_UNAVAILABLE":
      return new CliError("NETWORK_ERROR", error.message, { retryable: error.retryable }, 1);
    case "DI_SESSION_REQUIRED":
    case "DI_REFRESH_REJECTED":
    case "DI_TOKEN_REJECTED":
      return new CliError("AUTH_REQUIRED", "The Garmin session is missing or expired", {
        loginCommand: "gconnect auth login",
        recoveryCommand: "gconnect auth recover"
      }, 3);
    default:
      return new CliError(error.code, error.message, error.context, 3);
  }
}
