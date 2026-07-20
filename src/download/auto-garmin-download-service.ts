import { CliError } from "../core/errors.js";
import type { AuthStateCoordinator } from "../auth/auth-state.js";
import type { GarminDownloadService, JsonRequest } from "./contracts.js";

export interface AutoGarminDownloadOptions {
  readonly di: GarminDownloadService;
  readonly web: GarminDownloadService;
  readonly authState: Pick<AuthStateCoordinator, "activeBackend">;
}

export class AutoGarminDownloadService implements GarminDownloadService {
  readonly #di: GarminDownloadService;
  readonly #web: GarminDownloadService;
  readonly #authState: Pick<AuthStateCoordinator, "activeBackend">;
  #selected: Promise<GarminDownloadService> | null = null;

  public constructor(options: AutoGarminDownloadOptions) {
    this.#di = options.di;
    this.#web = options.web;
    this.#authState = options.authState;
  }

  public async json<T>(request: JsonRequest<T>): Promise<T> {
    return (await this.#select()).json(request);
  }

  public async optionalJson<T>(request: JsonRequest<T>): Promise<T | null> {
    return (await this.#select()).optionalJson(request);
  }

  public async profileId(): Promise<string> {
    return (await this.#select()).profileId();
  }

  public reset(): void {
    this.#selected = null;
  }

  async #select(): Promise<GarminDownloadService> {
    this.#selected ??= this.#resolve();
    return this.#selected;
  }

  async #resolve(): Promise<GarminDownloadService> {
    const backend = await this.#authState.activeBackend();
    if (backend === "private-di") return this.#di;
    if (backend === "web-cookie") return this.#web;
    throw new CliError("AUTH_REQUIRED", "No Garmin authentication session is stored", {
      loginCommand: "gconnect auth login",
      recoveryCommand: "gconnect auth recover"
    }, 3);
  }
}
