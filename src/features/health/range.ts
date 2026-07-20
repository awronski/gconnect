import {
  booleanOption,
  type ValidatedCommandInput
} from "../../cli/command-contract.js";
import type { CalendarDate } from "../../core/dates.js";
import { result, type CommandResult } from "../../core/result.js";
import type { FeatureContext } from "../context.js";
import { parseDateSelection, type DateSelection } from "../date-selector.js";

export interface HealthSelection extends DateSelection {
  readonly raw: boolean;
}

export interface HealthRangeItem<Data> {
  readonly date: CalendarDate;
  readonly data: Data | null;
}

export interface HealthRangeData<Data> {
  readonly items: readonly HealthRangeItem<Data>[];
}

interface HealthRangeDefinition<Wire, Normalized> {
  readonly command: string;
  readonly dataset: string;
  readonly sourceEndpoints: readonly string[];
  download(context: FeatureContext, date: CalendarDate): Promise<Wire | null>;
  normalize(context: FeatureContext, wire: Wire): Normalized;
}

export function parseHealthSelection(input: ValidatedCommandInput): HealthSelection {
  return {
    ...parseDateSelection(input),
    raw: booleanOption(input, "raw")
  };
}

export async function executeHealthRange<Wire, Normalized>(
  context: FeatureContext,
  selection: HealthSelection,
  definition: HealthRangeDefinition<Wire, Normalized>
): Promise<CommandResult<HealthRangeData<Wire | Normalized>>> {
  const dates = selection.dates;
  const items: HealthRangeItem<Wire | Normalized>[] = [];

  // Garmin's wellness endpoints are daily. Sequential requests keep range
  // downloads deterministic and avoid creating an avoidable rate-limit burst.
  for (const date of dates) {
    const wire = await definition.download(context, date);
    const normalized = wire === null ? null : definition.normalize(context, wire);
    items.push({
      date,
      data: wire === null || normalized === null
        ? null
        : selection.raw
          ? wire
          : context.processing.ids.normalizeKnown(normalized) as Normalized
    });
  }

  return result({
    command: definition.command,
    dataset: definition.dataset,
    sourceEndpoints: definition.sourceEndpoints,
    appliedOptions: selection.appliedOptions,
    raw: selection.raw,
    generatedAt: context.clock.now().toISOString(),
    data: { items }
  });
}
