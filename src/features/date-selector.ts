import { requiredString, type CommandRules, type OptionContract, type ValidatedCommandInput } from "../cli/command-contract.js";
import { calendarDateRange, parseCalendarDate, type CalendarDate } from "../core/dates.js";
import { RAW_OPTION } from "./raw-option.js";
import { AUTH_RECOVERY_OPTIONS } from "./auth-recovery-options.js";

export const DATE_SELECTOR_OPTIONS: Readonly<Record<string, OptionContract>> = Object.freeze({
  date: {
    type: "date",
    description: "Fetch one Garmin profile calendar date (YYYY-MM-DD)."
  },
  from: {
    type: "date",
    description: "First Garmin profile calendar date, inclusive (YYYY-MM-DD)."
  },
  to: {
    type: "date",
    description: "Last Garmin profile calendar date, inclusive (YYYY-MM-DD)."
  },
  raw: RAW_OPTION,
  ...AUTH_RECOVERY_OPTIONS
});

export const DATE_SELECTOR_RULES: CommandRules = Object.freeze({
  paired: [["from", "to"] as const],
  exactlyOneOf: [["date", "from"] as const],
  incompatible: [["recover-auth", "no-auth-recovery"] as const]
});

export interface DateSelection {
  readonly dates: readonly CalendarDate[];
  readonly appliedOptions: Readonly<{ date: CalendarDate } | { from: CalendarDate; to: CalendarDate }>;
}

export function parseDateSelection(
  input: ValidatedCommandInput,
  maximumDays = 366
): DateSelection {
  const date = input.options.date;
  if (typeof date === "string") {
    const parsed = parseCalendarDate(date, "date");
    return { dates: [parsed], appliedOptions: { date: parsed } };
  }
  const from = parseCalendarDate(requiredString(input, "from"), "from");
  const to = parseCalendarDate(requiredString(input, "to"), "to");
  return {
    dates: calendarDateRange(from, to, maximumDays),
    appliedOptions: { from, to }
  };
}
