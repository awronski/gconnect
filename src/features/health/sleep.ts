import { defineCommand } from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { ProtocolChangedError } from "../../core/errors.js";
import { isRecord } from "../../core/json.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import {
  executeHealthRange,
  parseHealthSelection,
  type HealthRangeData,
  type HealthSelection
} from "./range.js";
import { recordDecoder, type WireRecord } from "./wire.js";

const ENDPOINT = "/gc-api/sleep-service/sleep/dailySleepData";

const decodeSleepRecord = recordDecoder("sleep", ENDPOINT, {
  required: ["dailySleepDTO"],
  recordOrNull: ["dailySleepDTO", "wellnessSpO2SleepSummaryDTO"],
  arrays: [
    "sleepMovement",
    "sleepLevels",
    "sleepRestlessMoments",
    "wellnessEpochSPO2DataDTOList",
    "wellnessEpochRespirationDataDTOList",
    "wellnessEpochRespirationAveragesList",
    "sleepHeartRate",
    "sleepStress",
    "sleepBodyBattery",
    "hrvData",
    "breathingDisruptionData"
  ]
});

export const sleepCommand = defineCommand<HealthSelection, HealthRangeData<WireRecord>>({
  contract: {
    id: "health.sleep",
    path: ["health", "sleep"],
    summary: "Download Garmin sleep data for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health sleep --date 2026-07-17",
      "gconnect health sleep --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "sleep", shape: "collection" }
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.sleep",
    dataset: "sleep",
    sourceEndpoints: [ENDPOINT],
    download: (featureContext, date: CalendarDate) => featureContext.download.optionalJson({
      path: ENDPOINT,
      diPath: "/wellness-service/wellness/dailySleepData/{profileId}",
      query: { date, nonSleepBufferMinutes: 60 },
      decode: decodeSleep
    }),
    normalize: (_featureContext, wire) => wire
  })
});

function decodeSleep(input: unknown): WireRecord {
  const record = decodeSleepRecord(input);
  const dailySleep = record.dailySleepDTO;
  if (dailySleep !== null && (!isRecord(dailySleep) || typeof dailySleep.calendarDate !== "string")) {
    throw new ProtocolChangedError({
      feature: "sleep",
      field: "dailySleepDTO.calendarDate",
      issue: "expected a string when dailySleepDTO is present"
    });
  }
  return record;
}
