import type { RegisteredCommand } from "../cli/command-contract.js";

export interface FeatureModule {
  readonly id: string;
  readonly commands: readonly RegisteredCommand[];
}
