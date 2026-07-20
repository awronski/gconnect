import { defineCommand } from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { ProtocolChangedError } from "../../core/errors.js";
import type { FeatureContext } from "../context.js";
import { expectArray, expectNumber, expectRecord, expectString } from "../../core/json.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import {
  executeHealthRange,
  parseHealthSelection,
  type HealthRangeData,
  type HealthSelection
} from "./range.js";
import { normalizeDailyStress } from "./daily-stress.js";
import { decodeDescriptorSeriesList, recordArrayDecoder, recordDecoder, type WireRecord } from "./wire.js";

const STRESS_ENDPOINT = "/gc-api/wellness-service/wellness/dailyStress/{date}";
const EVENTS_ENDPOINT = "/gc-api/wellness-service/wellness/bodyBattery/events/{date}";

interface BodyBatteryDay {
  readonly dailyStress: WireRecord | null;
  readonly events: readonly WireRecord[];
}

export const bodyBatteryCommand = defineCommand<HealthSelection, HealthRangeData<BodyBatteryDay>>({
  contract: {
    id: "health.body-battery",
    path: ["health", "body-battery"],
    summary: "Download Garmin Body Battery series and events for one day or an inclusive date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect health body-battery --date 2026-07-17",
      "gconnect health body-battery --from 2026-07-01 --to 2026-07-07"
    ],
    output: { dataset: "body-battery", shape: "collection" },
    limitations: [
      "The date-independent messagingToday endpoint is intentionally excluded so historical output remains deterministic."
    ]
  },
  parse: parseHealthSelection,
  execute: (context, selection) => executeHealthRange(context, selection, {
    command: "health.body-battery",
    dataset: "body-battery",
    sourceEndpoints: [STRESS_ENDPOINT, EVENTS_ENDPOINT],
    download: downloadBodyBattery,
    normalize: normalizeBodyBattery
  })
});

async function downloadBodyBattery(context: FeatureContext, date: CalendarDate): Promise<BodyBatteryDay | null> {
  const stressPath = `/gc-api/wellness-service/wellness/dailyStress/${date}` as const;
  const eventsPath = `/gc-api/wellness-service/wellness/bodyBattery/events/${date}` as const;
  const [dailyStress, events] = await Promise.all([
    context.download.optionalJson({
      path: stressPath,
      decode: recordDecoder("body-battery", stressPath, {
        required: ["calendarDate", "bodyBatteryValueDescriptorsDTOList", "bodyBatteryValuesArray"],
        strings: ["calendarDate"],
        arrays: ["stressValueDescriptorsDTOList", "stressValuesArray", "bodyBatteryValueDescriptorsDTOList", "bodyBatteryValuesArray"]
      })
    }),
    context.download.optionalJson({
      path: eventsPath,
      decode: decodeBodyBatteryEvents
    })
  ]);
  if (dailyStress === null && (events === null || events.length === 0)) return null;
  return { dailyStress, events: events ?? [] };
}

function decodeBodyBatteryEvents(input: unknown): readonly WireRecord[] {
  const events = recordArrayDecoder("body-battery", EVENTS_ENDPOINT)(input);
  return events.map((inputEvent, index) => {
    try {
      const name = `body-battery events[${index}]`;
      const container = expectRecord(inputEvent, name);
      const event = expectRecord(container.event, `${name}.event`);
      for (const field of ["eventType", "eventStartTimeGmt", "feedbackType", "shortFeedback"] as const) {
        expectString(event[field], `${name}.event.${field}`);
      }
      for (const field of ["timezoneOffset", "durationInMilliseconds", "bodyBatteryImpact"] as const) {
        expectNumber(event[field], `${name}.event.${field}`);
      }
      for (const field of ["activityName", "activityType"] as const) {
        if (container[field] !== null) expectString(container[field], `${name}.${field}`);
      }
      if (
        container.activityId !== null
        && !(typeof container.activityId === "number" && Number.isSafeInteger(container.activityId))
        && !(typeof container.activityId === "string" && /^\d+$/.test(container.activityId))
      ) {
        throw new TypeError(`${name}.activityId must be a decimal identifier or null`);
      }
      if (container.averageStress !== null) {
        expectNumber(container.averageStress, `${name}.averageStress`);
      }
      for (const field of [
        "stressValueDescriptorsDTOList",
        "stressValuesArray",
        "bodyBatteryValueDescriptorsDTOList",
        "bodyBatteryValuesArray"
      ] as const) {
        if (container[field] !== null) {
          expectArray(container[field], `${name}.${field}`);
        }
      }
      return container;
    } catch (error) {
      if (error instanceof ProtocolChangedError) throw error;
      throw new ProtocolChangedError({
        feature: "body-battery",
        endpoint: EVENTS_ENDPOINT,
        issue: "event item does not match the expected contract",
        index
      }, error);
    }
  });
}

function normalizeBodyBattery(context: FeatureContext, wire: BodyBatteryDay): BodyBatteryDay {
  return {
    dailyStress: wire.dailyStress === null ? null : normalizeDailyStress(context, wire.dailyStress),
    events: wire.events.map((event) => decodeDescriptorSeriesList(context, event, "body-battery", [
      { descriptors: "stressValueDescriptorsDTOList", rows: "stressValuesArray" },
      {
        descriptors: "bodyBatteryValueDescriptorsDTOList",
        rows: "bodyBatteryValuesArray",
        index: "bodyBatteryValueDescriptorIndex",
        key: "bodyBatteryValueDescriptorKey",
        allowStrings: true
      }
    ]))
  };
}
