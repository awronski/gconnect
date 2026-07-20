import { defineCommand } from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import {
  executeHealthRange,
  parseHealthSelection,
  type HealthRangeData,
  type HealthSelection
} from "./range.js";
import { normalizeDailyStress } from "./daily-stress.js";
import { recordDecoder, type WireRecord } from "./wire.js";

const ENDPOINT = "/gc-api/wellness-service/wellness/dailyStress/{date}";

export const stressCommand = defineCommand<HealthSelection, HealthRangeData<WireRecord>>({
  contract: {
    id: "health.stress",
    path: ["health", "stress"],
    summary: "Download Garmin stress data for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health stress --date 2026-07-17",
      "gconnect health stress --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "stress", shape: "collection" }
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.stress",
    dataset: "stress",
    sourceEndpoints: [ENDPOINT],
    download: (featureContext, date: CalendarDate) => {
      const path = `/gc-api/wellness-service/wellness/dailyStress/${date}` as const;
      return featureContext.download.optionalJson({
        path,
        decode: recordDecoder("stress", path, {
          required: ["calendarDate", "stressValueDescriptorsDTOList", "stressValuesArray", "bodyBatteryValueDescriptorsDTOList", "bodyBatteryValuesArray"],
          strings: ["calendarDate", "startTimestampGMT", "endTimestampGMT", "startTimestampLocal", "endTimestampLocal"],
          arrays: ["stressValueDescriptorsDTOList", "stressValuesArray", "bodyBatteryValueDescriptorsDTOList", "bodyBatteryValuesArray"],
          nullableNumbers: ["maxStressLevel", "avgStressLevel", "stressChartValueOffset", "stressChartYAxisOrigin"]
        })
      });
    },
    normalize: normalizeDailyStress
  })
});
