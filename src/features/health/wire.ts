import { ProtocolChangedError } from "../../core/errors.js";
import { isRecord } from "../../core/json.js";
import type { DescriptorValue } from "../../processing/descriptor-rows.js";
import type { FeatureContext } from "../context.js";

export type WireRecord = Readonly<Record<string, unknown>>;

export interface RecordSchema {
  readonly required?: readonly string[];
  readonly strings?: readonly string[];
  readonly nullableNumbers?: readonly string[];
  readonly arrays?: readonly string[];
  readonly recordOrNull?: readonly string[];
}

interface DescriptorSeries {
  readonly descriptors: string;
  readonly rows: string;
  readonly index?: string;
  readonly key?: string;
  readonly allowStrings?: boolean;
}

export function recordDecoder(feature: string, endpoint: string, schema: RecordSchema = {}): (input: unknown) => WireRecord {
  return (input) => {
    if (!isRecord(input)) {
      throw new ProtocolChangedError({
        feature,
        endpoint,
        issue: "expected a top-level object"
      });
    }
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(input, field)) throw changed(feature, field, "required field is missing");
    }
    for (const field of schema.strings ?? []) {
      const value = input[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw changed(feature, field, "expected a string or null");
      }
    }
    for (const field of schema.nullableNumbers ?? []) {
      const value = input[field];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        throw changed(feature, field, "expected a finite number or null");
      }
    }
    for (const field of schema.arrays ?? []) {
      const value = input[field];
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        throw changed(feature, field, "expected an array or null");
      }
    }
    for (const field of schema.recordOrNull ?? []) {
      const value = input[field];
      if (value !== undefined && value !== null && !isRecord(value)) {
        throw changed(feature, field, "expected an object or null");
      }
    }
    return input;
  };
}

export function recordArrayDecoder(feature: string, endpoint: string): (input: unknown) => readonly WireRecord[] {
  return (input) => {
    if (!Array.isArray(input)) {
      throw new ProtocolChangedError({
        feature,
        endpoint,
        issue: "expected a top-level array"
      });
    }
    return input.map((item, index) => {
      if (!isRecord(item)) {
        throw new ProtocolChangedError({
          feature,
          endpoint,
          issue: "expected every array item to be an object",
          index
        });
      }
      return item;
    });
  };
}

export function decodeDescriptorSeries(
  context: FeatureContext,
  record: WireRecord,
  feature: string,
  series: DescriptorSeries
): WireRecord {
  const rawRows = record[series.rows];
  if (rawRows === null || rawRows === undefined) {
    return record;
  }
  if (!Array.isArray(rawRows)) {
    throw changed(feature, series.rows, "expected an array or null");
  }

  const rawDescriptors = record[series.descriptors];
  if (rawDescriptors === null || rawDescriptors === undefined) {
    if (rawRows.length === 0) {
      return record;
    }
    throw changed(feature, series.descriptors, "descriptors are required when rows are present");
  }
  if (!Array.isArray(rawDescriptors)) {
    throw changed(feature, series.descriptors, "expected an array");
  }

  const indexField = series.index ?? "index";
  const keyField = series.key ?? "key";
  const descriptors = rawDescriptors.map((descriptor, descriptorIndex) => {
    if (!isRecord(descriptor)) {
      throw changed(feature, series.descriptors, "descriptor must be an object", descriptorIndex);
    }
    const index = descriptor[indexField];
    const key = descriptor[keyField];
    if (!Number.isSafeInteger(index) || typeof key !== "string") {
      throw changed(feature, series.descriptors, "descriptor index/key is invalid", descriptorIndex);
    }
    return { index: index as number, key };
  });

  const rows = rawRows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.some((value) => !isDescriptorValue(value, series.allowStrings === true))) {
      throw changed(
        feature,
        series.rows,
        series.allowStrings === true
          ? "row must contain only finite numbers, strings, or null"
          : "row must contain only finite numbers or null",
        rowIndex
      );
    }
    return row as readonly DescriptorValue[];
  });

  return {
    ...record,
    [series.rows]: context.processing.descriptors.decode(descriptors, rows, feature)
  };
}

function isDescriptorValue(value: unknown, allowStrings: boolean): value is DescriptorValue {
  return value === null
    || (typeof value === "number" && Number.isFinite(value))
    || (allowStrings && typeof value === "string");
}

export function decodeDescriptorSeriesList(
  context: FeatureContext,
  record: WireRecord,
  feature: string,
  series: readonly DescriptorSeries[]
): WireRecord {
  return series.reduce(
    (current, descriptorSeries) => decodeDescriptorSeries(context, current, feature, descriptorSeries),
    record
  );
}

function changed(feature: string, field: string, issue: string, index?: number): ProtocolChangedError {
  return new ProtocolChangedError({
    feature,
    field,
    issue,
    ...(index === undefined ? {} : { index })
  });
}
