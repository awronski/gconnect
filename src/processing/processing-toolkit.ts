import { calendarDateRange, parseCalendarDate, type CalendarDate } from "../core/dates.js";
import { expectIdentifier } from "../core/json.js";
import {
  decodeDescriptorRows,
  type DecodedDescriptorRow,
  type DescriptorValue,
  type IndexedDescriptor
} from "./descriptor-rows.js";
import { normalizeKnownIds } from "./normalize-ids.js";

export interface ProcessingToolkit {
  readonly dates: {
    parse(value: string, optionName?: string): CalendarDate;
    range(from: CalendarDate, to: CalendarDate, maximumDays?: number): readonly CalendarDate[];
  };
  readonly descriptors: {
    decode<Value extends DescriptorValue>(
      descriptors: readonly IndexedDescriptor[],
      rows: readonly (readonly Value[])[],
      feature: string
    ): readonly DecodedDescriptorRow<Value>[];
  };
  readonly ids: {
    normalize(value: string | number): string;
    normalizeKnown(value: unknown): unknown;
  };
}

export const processingToolkit: ProcessingToolkit = {
  dates: {
    parse: parseCalendarDate,
    range: calendarDateRange
  },
  descriptors: {
    decode: decodeDescriptorRows
  },
  ids: {
    normalize: (value) => String(expectIdentifier(value, "Identifier")),
    normalizeKnown: normalizeKnownIds
  }
};
