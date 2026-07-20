import type { CommandRules, OptionContract } from "../cli/command-contract.js";

export const RECOVER_AUTH_OPTION: OptionContract = Object.freeze({
  type: "boolean",
  description: "Run browser-assisted authentication recovery when the saved session is invalid."
});

export const NO_AUTH_RECOVERY_OPTION: OptionContract = Object.freeze({
  type: "boolean",
  description: "Fail immediately instead of starting browser-assisted authentication recovery."
});

export const AUTH_RECOVERY_OPTIONS: Readonly<Record<string, OptionContract>> = Object.freeze({
  "recover-auth": RECOVER_AUTH_OPTION,
  "no-auth-recovery": NO_AUTH_RECOVERY_OPTION
});

export const AUTH_RECOVERY_RULES: CommandRules = Object.freeze({
  incompatible: [["recover-auth", "no-auth-recovery"] as const]
});
