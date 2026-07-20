import {
  booleanOption,
  defineCommand,
  integerOption,
  optionalStringOption,
  type ValidatedCommandInput
} from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { CliError } from "../../core/errors.js";
import { result } from "../../core/result.js";
import type { FeatureContext } from "../context.js";
import { RAW_OPTION } from "../raw-option.js";
import { AUTH_RECOVERY_OPTIONS } from "../auth-recovery-options.js";
import { normalizeActivitySummary, type ActivityCollection } from "./model.js";
import { ACTIVITIES_LIST_ENDPOINT, decodeActivityList, type ActivityListItemWire } from "./wire.js";

interface ActivitiesListOptions {
  readonly from?: CalendarDate;
  readonly to?: CalendarDate;
  readonly limit: number;
  readonly start: number;
  readonly activityType?: string;
  readonly raw: boolean;
}

export type ActivitiesListData = ActivityCollection | readonly ActivityListItemWire[];

export const activitiesListCommand = defineCommand<ActivitiesListOptions, ActivitiesListData>({
  contract: {
    id: "activities.list",
    path: ["activities", "list"],
    summary: "Download a page of Garmin Connect activities.",
    options: {
      from: { type: "date", description: "Optional inclusive activity start date (YYYY-MM-DD)." },
      to: { type: "date", description: "Optional inclusive activity end date (YYYY-MM-DD)." },
      limit: {
        type: "integer",
        defaultValue: 20,
        minimum: 1,
        maximum: 100,
        description: "Maximum activities to return (1-100)."
      },
      start: {
        type: "integer",
        defaultValue: 0,
        minimum: 0,
        description: "Zero-based activity offset."
      },
      type: { type: "string", description: "Optional Garmin activity type key." },
      raw: RAW_OPTION,
      ...AUTH_RECOVERY_OPTIONS
    },
    rules: {
      paired: [["from", "to"]],
      incompatible: [["recover-auth", "no-auth-recovery"]]
    },
    examples: [
      "gconnect activities list",
      "gconnect activities list --from 2026-07-01 --to 2026-07-17 --type walking --limit 50"
    ],
    output: { dataset: "activities", shape: "collection" },
    limitations: ["Activity filter query names are private Garmin web API behavior and may change without notice."]
  },
  parse: parseActivitiesListOptions,
  execute: executeActivitiesList
});

function parseActivitiesListOptions(input: ValidatedCommandInput): ActivitiesListOptions {
  const from = optionalStringOption(input, "from") as CalendarDate | undefined;
  const to = optionalStringOption(input, "to") as CalendarDate | undefined;
  if (from !== undefined && to !== undefined && from > to) {
    throw new CliError("INVALID_DATE_RANGE", "--from must be before or equal to --to", { from, to });
  }
  const activityType = optionalStringOption(input, "type");
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    limit: integerOption(input, "limit"),
    start: integerOption(input, "start"),
    ...(activityType === undefined ? {} : { activityType }),
    raw: booleanOption(input, "raw")
  };
}

async function executeActivitiesList(
  context: FeatureContext,
  options: ActivitiesListOptions
): Promise<ReturnType<typeof result<ActivitiesListData>>> {
  const query: Record<string, string | number> = {
    start: options.start,
    limit: options.limit
  };
  if (options.from !== undefined) query.startDate = options.from;
  if (options.to !== undefined) query.endDate = options.to;
  if (options.activityType !== undefined) query.activityType = options.activityType;

  const wire = await context.download.json({
    path: ACTIVITIES_LIST_ENDPOINT,
    query,
    decode: decodeActivityList
  });
  const data: ActivitiesListData = options.raw
    ? wire
    : {
        items: wire.map(normalizeActivitySummary),
        page: {
          start: options.start,
          limit: options.limit,
          hasMore: wire.length < options.limit ? false : null
        }
      };

  return result({
    command: "activities.list",
    dataset: "activities",
    sourceEndpoints: [ACTIVITIES_LIST_ENDPOINT],
    appliedOptions: {
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      limit: options.limit,
      start: options.start,
      ...(options.activityType === undefined ? {} : { type: options.activityType })
    },
    data,
    raw: options.raw,
    generatedAt: context.clock.now().toISOString()
  });
}
