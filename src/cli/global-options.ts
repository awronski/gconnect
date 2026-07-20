import type { OptionContract } from "./command-contract.js";

export const GLOBAL_OPTIONS: Readonly<Record<string, OptionContract>> = Object.freeze({
  help: {
    type: "boolean",
    defaultValue: false,
    description: "Return machine-readable help for the selected command."
  },
  output: {
    type: "string",
    description: "Write JSON atomically to this filename inside the private output directory."
  }
});

export const ROOT_OPTIONS: Readonly<Record<string, OptionContract>> = Object.freeze({
  ...GLOBAL_OPTIONS,
  version: {
    type: "boolean",
    defaultValue: false,
    description: "Return the CLI version as JSON."
  }
});
