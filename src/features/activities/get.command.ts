import {
  booleanOption,
  defineCommand,
  requiredString,
  type ValidatedCommandInput
} from "../../cli/command-contract.js";
import { CliError } from "../../core/errors.js";
import { result } from "../../core/result.js";
import type { FeatureContext } from "../context.js";
import { RAW_OPTION } from "../raw-option.js";
import { AUTH_RECOVERY_OPTIONS, AUTH_RECOVERY_RULES } from "../auth-recovery-options.js";
import {
  normalizeActivityDetails,
  normalizeActivityPolyline,
  type ActivityGetData,
  type NormalizedActivityDetails,
  type NormalizedActivityPolyline
} from "./model.js";
import {
  decodeActivityDetails,
  decodeActivityPolyline,
  type ActivityDetailsWire,
  type ActivityPolylineWire
} from "./wire.js";

interface ActivityGetOptions {
  readonly activityId: string;
  readonly includeDetails: boolean;
  readonly includePolyline: boolean;
  readonly raw: boolean;
}

type NormalizedActivityGetData = ActivityGetData<NormalizedActivityDetails, NormalizedActivityPolyline>;
type RawActivityGetData = ActivityGetData<ActivityDetailsWire, ActivityPolylineWire>;
export type ActivitiesGetData = NormalizedActivityGetData | RawActivityGetData;

export const activitiesGetCommand = defineCommand<ActivityGetOptions, ActivitiesGetData>({
  contract: {
    id: "activities.get",
    path: ["activities", "get"],
    summary: "Download activity chart details and optionally its full-resolution polyline.",
    options: {
      "include-details": {
        type: "boolean",
        defaultValue: true,
        description: "Include descriptor-based activity chart details (default: true)."
      },
      "include-polyline": {
        type: "boolean",
        defaultValue: false,
        description: "Include the full-resolution activity polyline."
      },
      raw: RAW_OPTION,
      ...AUTH_RECOVERY_OPTIONS
    },
    rules: AUTH_RECOVERY_RULES,
    positionals: [{ name: "activity-id", description: "Garmin decimal activity identifier." }],
    examples: [
      "gconnect activities get 123456789",
      "gconnect activities get 123456789 --include-polyline",
      "gconnect activities get 123456789 --include-details=false --include-polyline"
    ],
    output: { dataset: "activity", shape: "document" },
    limitations: ["Polyline tuple semantics remain raw because their three value meanings are not yet verified."]
  },
  parse: parseActivityGetOptions,
  execute: executeActivityGet
});

function parseActivityGetOptions(input: ValidatedCommandInput): ActivityGetOptions {
  const activityId = requiredString(input, "activity-id");
  if (!/^\d+$/.test(activityId)) {
    throw new CliError("INVALID_ACTIVITY_ID", "activity-id must be a decimal integer", {
      activityId: "[provided]"
    });
  }
  const includeDetails = booleanOption(input, "include-details");
  const includePolyline = booleanOption(input, "include-polyline");
  if (!includeDetails && !includePolyline) {
    throw new CliError(
      "INVALID_OPTION_COMBINATION",
      "At least one of --include-details or --include-polyline must be enabled",
      { options: ["include-details", "include-polyline"] }
    );
  }
  return {
    activityId,
    includeDetails,
    includePolyline,
    raw: booleanOption(input, "raw")
  };
}

async function executeActivityGet(
  context: FeatureContext,
  options: ActivityGetOptions
): Promise<ReturnType<typeof result<ActivitiesGetData>>> {
  const detailsPath = `/gc-api/activity-service/activity/${options.activityId}/details` as const;
  const polylinePath = `/gc-api/activity-service/activity/${options.activityId}/polyline/full-resolution/` as const;

  const [details, polyline] = await Promise.all([
    options.includeDetails
      ? context.download.json({
          path: detailsPath,
          query: { maxChartSize: 10000, maxPolylineSize: 0, maxHeatMapSize: 2000 },
          decode: decodeActivityDetails
        })
      : Promise.resolve(null),
    options.includePolyline
      ? context.download.json({ path: polylinePath, decode: decodeActivityPolyline })
      : Promise.resolve(null)
  ]);

  const data: ActivitiesGetData = options.raw
    ? { activityId: options.activityId, details, polyline }
    : {
        activityId: options.activityId,
        details: details === null ? null : normalizeActivityDetails(details, context.processing),
        polyline: polyline === null ? null : normalizeActivityPolyline(polyline)
      };
  const sourceEndpoints = [
    ...(options.includeDetails ? [detailsPath] : []),
    ...(options.includePolyline ? [polylinePath] : [])
  ];

  return result({
    command: "activities.get",
    dataset: "activity",
    sourceEndpoints,
    appliedOptions: {
      activityId: options.activityId,
      includeDetails: options.includeDetails,
      includePolyline: options.includePolyline
    },
    data,
    raw: options.raw,
    warnings: options.includePolyline
      ? ["Full-resolution polyline tuple values are preserved without guessed semantic labels."]
      : [],
    generatedAt: context.clock.now().toISOString()
  });
}
