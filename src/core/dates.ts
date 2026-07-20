import { CliError } from "./errors.js";

export type CalendarDate = string & { readonly __brand: "CalendarDate" };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value: string, optionName = "date"): CalendarDate {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new CliError("INVALID_DATE", `--${optionName} must use YYYY-MM-DD`, { option: optionName, value });
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new CliError("INVALID_DATE", `--${optionName} must use YYYY-MM-DD`, { option: optionName, value });
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CliError("INVALID_DATE", `--${optionName} is not a real calendar date`, { option: optionName, value });
  }
  return value as CalendarDate;
}

export function calendarDateRange(from: CalendarDate, to: CalendarDate, maximumDays = 366): CalendarDate[] {
  if (from > to) {
    throw new CliError("INVALID_DATE_RANGE", "--from must be before or equal to --to", { from, to });
  }
  const result: CalendarDate[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let timestamp = Date.parse(`${from}T00:00:00Z`); timestamp <= end; timestamp += 86_400_000) {
    result.push(new Date(timestamp).toISOString().slice(0, 10) as CalendarDate);
    if (result.length > maximumDays) {
      throw new CliError("DATE_RANGE_TOO_LARGE", `Date range cannot exceed ${maximumDays} days`, {
        from,
        to,
        maximumDays
      });
    }
  }
  return result;
}
