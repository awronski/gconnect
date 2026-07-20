import type { OptionContract } from "../cli/command-contract.js";

export const RAW_OPTION: OptionContract = Object.freeze({
  type: "boolean",
  defaultValue: false,
  description: "Return Garmin's decoded wire payload without domain normalization."
});
