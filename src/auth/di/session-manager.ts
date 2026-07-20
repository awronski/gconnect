import type { DiTokenLifecycle, DiTokenSet, DiTokenStore } from "./contracts.js";
import { DiAuthError, isDiAuthError } from "./errors.js";
import type { AuthStateCoordinator } from "../auth-state.js";

export interface DiSessionManagerOptions {
  readonly store: DiTokenStore;
  readonly lifecycle: Pick<DiTokenLifecycle, "refresh" | "validate">;
  readonly authState: Pick<AuthStateCoordinator, "runExclusive">;
  readonly now?: () => number;
  readonly refreshSkewMs?: number;
}

export class DiSessionManager {
  readonly #store: DiTokenStore;
  readonly #lifecycle: Pick<DiTokenLifecycle, "refresh" | "validate">;
  readonly #authState: Pick<AuthStateCoordinator, "runExclusive">;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  #refreshInFlight: Promise<DiTokenSet> | null = null;

  public constructor(options: DiSessionManagerOptions) {
    this.#store = options.store;
    this.#lifecycle = options.lifecycle;
    this.#authState = options.authState;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? 15 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#refreshSkewMs) || this.#refreshSkewMs < 0) {
      throw new TypeError("DI refresh skew must be a non-negative safe integer");
    }
  }

  public async getValidSession(signal?: AbortSignal): Promise<DiTokenSet> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight;
    const tokens = await this.#requireStoredSession();
    return this.#needsRefresh(tokens) ? this.#refreshSingleFlight(tokens, false, signal) : tokens;
  }

  public async forceRefresh(signal?: AbortSignal): Promise<DiTokenSet> {
    return this.#refreshSingleFlight(await this.#requireStoredSession(), true, signal);
  }

  public async adopt(tokens: DiTokenSet, signal?: AbortSignal): Promise<void> {
    await this.#lifecycle.validate(tokens, signal);
    await this.#authState.runExclusive(() => this.#store.save(tokens));
  }

  public async runWithSession<T>(
    operation: (tokens: DiTokenSet) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const tokens = await this.getValidSession(signal);
    try {
      return await operation(tokens);
    } catch (error) {
      if (!isDiAuthError(error, "DI_TOKEN_REJECTED")) throw error;
      const refreshed = await this.#refreshSingleFlight(tokens, true, signal);
      return operation(refreshed);
    }
  }

  public async clear(): Promise<void> {
    await this.#authState.runExclusive(() => this.#store.delete());
  }

  async #requireStoredSession(): Promise<DiTokenSet> {
    const tokens = await this.#store.load();
    if (tokens === null) {
      throw new DiAuthError("DI_SESSION_REQUIRED", "No stored Garmin private-DI session is available");
    }
    return tokens;
  }

  #needsRefresh(tokens: DiTokenSet): boolean {
    return tokens.accessExpiresAtEpochMs !== null
      && this.#now() >= tokens.accessExpiresAtEpochMs - this.#refreshSkewMs;
  }

  #refreshSingleFlight(tokens: DiTokenSet, force: boolean, signal: AbortSignal | undefined): Promise<DiTokenSet> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight;
    const refresh = this.#refreshAndValidate(tokens, force, signal);
    this.#refreshInFlight = refresh;
    void refresh.finally(() => {
      if (this.#refreshInFlight === refresh) this.#refreshInFlight = null;
    }).catch(() => undefined);
    return refresh;
  }

  async #refreshAndValidate(
    observed: DiTokenSet,
    force: boolean,
    signal: AbortSignal | undefined
  ): Promise<DiTokenSet> {
    return this.#authState.runExclusive(async () => {
      // The lock can be contended by another process. Always re-read after acquiring it so a
      // rotated refresh token is never reused and an already-fresh session is not refreshed twice.
      const current = await this.#requireStoredSession();
      if (!sameTokenPair(current, observed) || (!force && !this.#needsRefresh(current))) return current;
      const refreshed = await this.#lifecycle.refresh(current, signal);
      // Refresh tokens can rotate. Persist the new pair before any subsequent network operation.
      await this.#store.save(refreshed);
      await this.#lifecycle.validate(refreshed, signal);
      return refreshed;
    });
  }
}

function sameTokenPair(left: DiTokenSet, right: DiTokenSet): boolean {
  return left.clientId === right.clientId
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken;
}
