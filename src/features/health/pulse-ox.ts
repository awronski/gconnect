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

const ENDPOINT = "/gc-api/wellness-service/wellness/daily/spo2acclimation/{date}";

export const pulseOxCommand = defineCommand<HealthSelection, HealthRangeData<WireRecord>>({
  contract: {
    id: "health.pulse-ox",
    path: ["health", "pulse-ox"],
    summary: "Download Garmin Pulse Ox and acclimation data for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health pulse-ox --date 2026-07-17",
      "gconnect health pulse-ox --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "pulse-ox", shape: "collection" },
    limitations: [
      "Sleep Pulse Ox samples are also present in health sleep; this command uses Garmin's date-addressed Pulse Ox/acclimation endpoint."
    ]
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.pulse-ox",
    dataset: "pulse-ox",
    sourceEndpoints: [ENDPOINT],
    download: (featureContext, date: CalendarDate) => {
      const path = `/gc-api/wellness-service/wellness/daily/spo2acclimation/${date}` as const;
      return featureContext.download.optionalJson({
        path,
        diPath: `/wellness-service/wellness/daily/spo2/${date}`,
        decode: recordDecoder("pulse-ox", path, {
          required: ["spO2SingleValuesDescriptorList", "spO2HourlyAveragesDescriptorList"],
          arrays: [
            "spO2SingleValuesDescriptorList",
            "spO2SingleValues",
            "spO2HourlyAveragesDescriptorList",
            "spO2HourlyAverages",
            "monitoringEnvironmentValuesDescriptorList",
            "monitoringEnvironmentValues"
          ],
          nullableNumbers: ["averageSpO2", "lowestSpO2", "lastSevenDaysAvgSpO2", "latestSpO2", "averageSleepSpO2"]
        })
      });
    },
    normalize: (featureContext, wire) => decodeDescriptorSeriesList(featureContext, wire, "pulse-ox", [
      { descriptors: "spO2SingleValuesDescriptorList", rows: "spO2SingleValues" },
      { descriptors: "spO2HourlyAveragesDescriptorList", rows: "spO2HourlyAverages" },
      { descriptors: "monitoringEnvironmentValuesDescriptorList", rows: "monitoringEnvironmentValues" }
    ])
  })
});
