import { booleanOption, type ValidatedCommandInput } from "../../cli/command-contract.js";
import { parseDateSelection, type DateSelection } from "../date-selector.js";

export interface PerformanceDateOptions {
  readonly selection: DateSelection;
  readonly raw: boolean;
}

export function parsePerformanceDateOptions(input: ValidatedCommandInput): PerformanceDateOptions {
  return { selection: parseDateSelection(input), raw: booleanOption(input, "raw") };
}
