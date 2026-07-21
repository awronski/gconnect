import { ProtocolChangedError } from "../../core/errors.js";
import {
  expectArray,
  expectIdentifier,
  expectNumber,
  expectRecord,
  expectString,
  isRecord
} from "../../core/json.js";

export const ACTIVITIES_LIST_ENDPOINT = "/gc-api/activitylist-service/activities/search/activities" as const;
export const ACTIVITIES_COUNT_ENDPOINT = "/gc-api/activitylist-service/activities/count" as const;
export const ACTIVITY_DETAILS_ENDPOINT = "/gc-api/activity-service/activity/{activityId}/details" as const;
export const ACTIVITY_POLYLINE_ENDPOINT = "/gc-api/activity-service/activity/{activityId}/polyline/full-resolution/" as const;

export interface ActivityListItemWire {
  readonly activityId: string | number;
  readonly activityUUID?: string;
  readonly activityName?: string;
  readonly activityType?: Readonly<Record<string, unknown>>;
  readonly startTimeLocal?: string;
  readonly startTimeGMT?: string;
  readonly distance?: number;
  readonly duration?: number;
  readonly movingDuration?: number;
  readonly calories?: number;
  readonly averageHR?: number;
  readonly maxHR?: number;
  readonly deviceId?: string | number;
  readonly hasPolyline?: boolean;
  readonly [additionalField: string]: unknown;
}

export interface ActivityCountWire {
  readonly totalCount: number;
  readonly [additionalField: string]: unknown;
}

export interface ActivityMetricDescriptorWire {
  readonly metricsIndex: number;
  readonly key: string;
  readonly unit: {
    readonly id: number;
    readonly key: string;
    readonly factor: number;
  };
}

export interface ActivityDetailsWire {
  readonly activityId: string | number;
  readonly measurementCount: number;
  readonly metricsCount: number;
  readonly totalMetricsCount: number;
  readonly metricDescriptors: readonly ActivityMetricDescriptorWire[];
  readonly activityDetailMetrics: readonly {
    readonly metrics: readonly (number | null)[];
  }[];
  readonly detailsAvailable: boolean;
  readonly [additionalField: string]: unknown;
}

export interface ActivityPolylineWire {
  readonly polyline: readonly (readonly [number, number, number])[];
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
  readonly [additionalField: string]: unknown;
}

export function decodeActivityList(input: unknown): readonly ActivityListItemWire[] {
  return decodeEndpoint(ACTIVITIES_LIST_ENDPOINT, () =>
    expectArray(input, "activities response").map((item, index) => decodeActivityListItem(item, index))
  );
}

export function decodeActivityCount(input: unknown): ActivityCountWire {
  return decodeEndpoint(ACTIVITIES_COUNT_ENDPOINT, () => {
    const record = expectRecord(input, "activities count response");
    return {
      ...record,
      totalCount: expectNonNegativeInteger(record.totalCount, "activities count response totalCount")
    };
  });
}

export function decodeActivityDetails(input: unknown): ActivityDetailsWire {
  return decodeEndpoint(ACTIVITY_DETAILS_ENDPOINT, () => {
    const record = expectRecord(input, "activity details response");
    const metricDescriptors = expectArray(record.metricDescriptors, "activity details metricDescriptors").map(
      decodeMetricDescriptor
    );
    const activityDetailMetrics = expectArray(
      record.activityDetailMetrics,
      "activity details activityDetailMetrics"
    ).map((item, index) => {
      const metricRecord = expectRecord(item, `activity details activityDetailMetrics[${index}]`);
      const metrics = expectArray(metricRecord.metrics, `activity details activityDetailMetrics[${index}].metrics`).map(
        (value, metricIndex) => {
          if (value === null) return null;
          return expectNumber(value, `activity details activityDetailMetrics[${index}].metrics[${metricIndex}]`);
        }
      );
      return { ...metricRecord, metrics };
    });

    expectIdentifier(record.activityId, "activity details activityId");
    return {
      ...record,
      activityId: record.activityId as string | number,
      measurementCount: expectNonNegativeInteger(record.measurementCount, "activity details measurementCount"),
      metricsCount: expectNonNegativeInteger(record.metricsCount, "activity details metricsCount"),
      totalMetricsCount: expectNonNegativeInteger(record.totalMetricsCount, "activity details totalMetricsCount"),
      metricDescriptors,
      activityDetailMetrics,
      detailsAvailable: expectBoolean(record.detailsAvailable, "activity details detailsAvailable")
    };
  });
}

export function decodeActivityPolyline(input: unknown): ActivityPolylineWire {
  return decodeEndpoint(ACTIVITY_POLYLINE_ENDPOINT, () => {
    const record = expectRecord(input, "activity polyline response");
    const polyline = expectArray(record.polyline, "activity polyline").map((point, index) => {
      const tuple = expectArray(point, `activity polyline[${index}]`);
      if (tuple.length !== 3) {
        throw new TypeError(`activity polyline[${index}] must contain exactly three values`);
      }
      return [
        expectNumber(tuple[0], `activity polyline[${index}][0]`),
        expectNumber(tuple[1], `activity polyline[${index}][1]`),
        expectNumber(tuple[2], `activity polyline[${index}][2]`)
      ] as const;
    });

    return {
      ...record,
      polyline,
      minLat: expectNumber(record.minLat, "activity polyline minLat"),
      maxLat: expectNumber(record.maxLat, "activity polyline maxLat"),
      minLon: expectNumber(record.minLon, "activity polyline minLon"),
      maxLon: expectNumber(record.maxLon, "activity polyline maxLon")
    };
  });
}

function decodeActivityListItem(input: unknown, index: number): ActivityListItemWire {
  const record = expectRecord(input, `activities response[${index}]`);
  validateOptionalString(record, "activityUUID", index);
  validateOptionalString(record, "activityName", index);
  validateOptionalString(record, "startTimeLocal", index);
  validateOptionalString(record, "startTimeGMT", index);
  validateOptionalNumber(record, "distance", index);
  validateOptionalNumber(record, "duration", index);
  validateOptionalNumber(record, "movingDuration", index);
  validateOptionalNumber(record, "calories", index);
  validateOptionalNumber(record, "averageHR", index);
  validateOptionalNumber(record, "maxHR", index);
  validateOptionalBoolean(record, "hasPolyline", index);
  if (record.activityType !== undefined && !isRecord(record.activityType)) {
    throw new TypeError(`activities response[${index}].activityType must be an object`);
  }

  const decoded: Record<string, unknown> = {
    ...record
  };
  expectIdentifier(record.activityId, `activities response[${index}].activityId`);
  if (record.deviceId !== undefined && record.deviceId !== null) {
    expectIdentifier(record.deviceId, `activities response[${index}].deviceId`);
  }
  return decoded as ActivityListItemWire;
}

function decodeMetricDescriptor(input: unknown, index: number): ActivityMetricDescriptorWire {
  const record = expectRecord(input, `activity details metricDescriptors[${index}]`);
  const unit = expectRecord(record.unit, `activity details metricDescriptors[${index}].unit`);
  return {
    ...record,
    metricsIndex: expectNonNegativeInteger(
      record.metricsIndex,
      `activity details metricDescriptors[${index}].metricsIndex`
    ),
    key: expectString(record.key, `activity details metricDescriptors[${index}].key`),
    unit: {
      ...unit,
      id: expectNumber(unit.id, `activity details metricDescriptors[${index}].unit.id`),
      key: expectString(unit.key, `activity details metricDescriptors[${index}].unit.key`),
      factor: expectNumber(unit.factor, `activity details metricDescriptors[${index}].unit.factor`)
    }
  };
}

function expectNonNegativeInteger(value: unknown, name: string): number {
  const result = expectNumber(value, name);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return result;
}

function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function validateOptionalString(record: Readonly<Record<string, unknown>>, key: string, index: number): void {
  const value = record[key];
  if (value !== undefined && value !== null) expectString(value, `activities response[${index}].${key}`);
}

function validateOptionalNumber(record: Readonly<Record<string, unknown>>, key: string, index: number): void {
  const value = record[key];
  if (value !== undefined && value !== null) expectNumber(value, `activities response[${index}].${key}`);
}

function validateOptionalBoolean(record: Readonly<Record<string, unknown>>, key: string, index: number): void {
  const value = record[key];
  if (value !== undefined && value !== null) expectBoolean(value, `activities response[${index}].${key}`);
}

function decodeEndpoint<T>(endpoint: string, decode: () => T): T {
  try {
    return decode();
  } catch (cause) {
    if (cause instanceof ProtocolChangedError) throw cause;
    throw new ProtocolChangedError({ feature: "activities", endpoint }, cause);
  }
}
