import { defineCommand } from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import {
  executeHealthRange,
  parseHealthSelection,
  type HealthRangeData,
  type HealthSelection
} from "./range.js";
import { decodeDescriptorSeriesList, recordDecoder, type WireRecord } from "./wire.js";

const ENDPOINT = "/gc-api/wellness-service/wellness/daily/respiration/{date}";

export const respirationCommand = defineCommand<HealthSelection, HealthRangeData<WireRecord>>({
  contract: {
    id: "health.respiration",
    path: ["health", "respiration"],
    summary: "Download Garmin respiration data for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health respiration --date 2026-07-17",
      "gconnect health respiration --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "respiration", shape: "collection" }
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.respiration",
    dataset: "respiration",
    sourceEndpoints: [ENDPOINT],
    download: (featureContext, date: CalendarDate) => {
      const path = `/gc-api/wellness-service/wellness/daily/respiration/${date}` as const;
      return featureContext.download.optionalJson({
        path,
        decode: recordDecoder("respiration", path, {
          required: ["calendarDate", "respirationValueDescriptorsDTOList", "respirationValuesArray"],
          strings: ["calendarDate", "startTimestampGMT", "endTimestampGMT", "startTimestampLocal", "endTimestampLocal"],
          arrays: [
            "respirationValueDescriptorsDTOList",
            "respirationValuesArray",
            "respirationAveragesValueDescriptorDTOList",
            "respirationAveragesValuesArray"
          ],
          nullableNumbers: ["lowestRespirationValue", "highestRespirationValue", "avgWakingRespirationValue", "avgSleepRespirationValue"]
        })
      });
    },
    normalize: (featureContext, wire) => decodeDescriptorSeriesList(featureContext, wire, "respiration", [
      {
        descriptors: "respirationValueDescriptorsDTOList",
        rows: "respirationValuesArray"
      },
      {
        descriptors: "respirationAveragesValueDescriptorDTOList",
        rows: "respirationAveragesValuesArray"
      }
    ])
  })
});
