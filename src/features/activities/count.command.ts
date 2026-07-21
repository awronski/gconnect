import {
  booleanOption,
  defineCommand,
  type ValidatedCommandInput
} from "../../cli/command-contract.js";
import { result } from "../../core/result.js";
import type { FeatureContext } from "../context.js";
import { AUTH_RECOVERY_OPTIONS, AUTH_RECOVERY_RULES } from "../auth-recovery-options.js";
import { RAW_OPTION } from "../raw-option.js";
import {
  ACTIVITIES_COUNT_ENDPOINT,
  decodeActivityCount,
  type ActivityCountWire
} from "./wire.js";

interface ActivitiesCountOptions {
  readonly raw: boolean;
}

interface ActivitiesCountData {
  readonly total: number;
}

export const activitiesCountCommand = defineCommand<ActivitiesCountOptions, ActivitiesCountData | ActivityCountWire>({
  contract: {
    id: "activities.count",
    path: ["activities", "count"],
    summary: "Return the account-wide total number of Garmin Connect activities.",
    options: {
      raw: RAW_OPTION,
      ...AUTH_RECOVERY_OPTIONS
    },
    rules: AUTH_RECOVERY_RULES,
    examples: ["gconnect activities count"],
    output: { dataset: "activities.count", shape: "document" },
    limitations: [
      "Garmin's count endpoint is account-wide; filtered totals are not exposed because matching filter behavior is unverified."
    ]
  },
  parse: parseActivitiesCountOptions,
  execute: executeActivitiesCount
});

function parseActivitiesCountOptions(input: ValidatedCommandInput): ActivitiesCountOptions {
  return { raw: booleanOption(input, "raw") };
}

async function executeActivitiesCount(
  context: FeatureContext,
  options: ActivitiesCountOptions
): Promise<ReturnType<typeof result<ActivitiesCountData | ActivityCountWire>>> {
  const wire = await context.download.json({
    path: ACTIVITIES_COUNT_ENDPOINT,
    decode: decodeActivityCount
  });

  return result({
    command: "activities.count",
    dataset: "activities.count",
    sourceEndpoints: [ACTIVITIES_COUNT_ENDPOINT],
    appliedOptions: {},
    data: options.raw ? wire : { total: wire.totalCount },
    raw: options.raw,
    generatedAt: context.clock.now().toISOString()
  });
}
