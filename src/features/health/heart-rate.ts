import { defineCommand } from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import {
  executeHealthRange,
  parseHealthSelection,
  type HealthRangeData,
  type HealthSelection
} from "./range.js";
import { decodeDescriptorSeries, recordDecoder, type WireRecord } from "./wire.js";

const ENDPOINT = "/gc-api/wellness-service/wellness/dailyHeartRate";

export const heartRateCommand = defineCommand<HealthSelection, HealthRangeData<WireRecord>>({
  contract: {
    id: "health.heart-rate",
    path: ["health", "heart-rate"],
    summary: "Download Garmin daily heart-rate data for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health heart-rate --date 2026-07-17",
      "gconnect health heart-rate --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "heart-rate", shape: "collection" }
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.heart-rate",
    dataset: "heart-rate",
    sourceEndpoints: [ENDPOINT],
    download: (featureContext, date: CalendarDate) => featureContext.download.optionalJson({
      path: ENDPOINT,
      diPath: "/wellness-service/wellness/dailyHeartRate/{profileId}",
      query: { date },
      decode: recordDecoder("heart-rate", ENDPOINT, {
        required: ["calendarDate", "heartRateValueDescriptors", "heartRateValues"],
        strings: ["calendarDate", "startTimestampGMT", "endTimestampGMT", "startTimestampLocal", "endTimestampLocal"],
        arrays: ["heartRateValueDescriptors", "heartRateValues"],
        nullableNumbers: ["maxHeartRate", "minHeartRate", "restingHeartRate", "lastSevenDaysAvgRestingHeartRate"]
      })
    }),
    normalize: (featureContext, wire) => decodeDescriptorSeries(featureContext, wire, "heart-rate", {
      descriptors: "heartRateValueDescriptors",
      rows: "heartRateValues"
    })
  })
});
