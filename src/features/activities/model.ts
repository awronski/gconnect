import type { ProcessingToolkit } from "../../processing/processing-toolkit.js";
import type {
  ActivityDetailsWire,
  ActivityListItemWire,
  ActivityMetricDescriptorWire,
  ActivityPolylineWire
} from "./wire.js";

export interface ActivitySummary {
  readonly id: string;
  readonly uuid: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly startTimeLocal: string | null;
  readonly startTimeGmt: string | null;
  readonly distanceMeters: number | null;
  readonly durationSeconds: number | null;
  readonly movingDurationSeconds: number | null;
  readonly calories: number | null;
  readonly averageHeartRate: number | null;
  readonly maxHeartRate: number | null;
  readonly deviceId: string | null;
  readonly hasPolyline: boolean | null;
}

export interface ActivityCollection {
  readonly items: readonly ActivitySummary[];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly returned: number;
    readonly nextOffset: number | null;
  };
}

export interface NormalizedActivityDetails {
  readonly activityId: string;
  readonly measurementCount: number;
  readonly metricsCount: number;
  readonly totalMetricsCount: number;
  readonly detailsAvailable: boolean;
  readonly metricDescriptors: readonly ActivityMetricDescriptorWire[];
  readonly metrics: readonly Readonly<Record<string, number | null>>[];
}

export interface NormalizedActivityPolyline {
  readonly points: readonly (readonly [number, number, number])[];
  readonly bounds: {
    readonly minLat: number;
    readonly maxLat: number;
    readonly minLon: number;
    readonly maxLon: number;
  };
}

export interface ActivityGetData<Details, Polyline> {
  readonly activityId: string;
  readonly details: Details | null;
  readonly polyline: Polyline | null;
}

export function normalizeActivitySummary(wire: ActivityListItemWire): ActivitySummary {
  return {
    id: String(wire.activityId),
    uuid: optionalString(wire.activityUUID),
    name: optionalString(wire.activityName),
    type: activityTypeKey(wire.activityType),
    startTimeLocal: optionalString(wire.startTimeLocal),
    startTimeGmt: optionalString(wire.startTimeGMT),
    distanceMeters: optionalNumber(wire.distance),
    durationSeconds: optionalNumber(wire.duration),
    movingDurationSeconds: optionalNumber(wire.movingDuration),
    calories: optionalNumber(wire.calories),
    averageHeartRate: optionalNumber(wire.averageHR),
    maxHeartRate: optionalNumber(wire.maxHR),
    deviceId: optionalIdentifier(wire.deviceId),
    hasPolyline: typeof wire.hasPolyline === "boolean" ? wire.hasPolyline : null
  };
}

export function normalizeActivityDetails(
  wire: ActivityDetailsWire,
  processing: ProcessingToolkit
): NormalizedActivityDetails {
  const descriptors = wire.metricDescriptors.map((descriptor) => ({
    index: descriptor.metricsIndex,
    key: descriptor.key
  }));
  const rows = wire.activityDetailMetrics.map((item) => item.metrics);
  return {
    activityId: String(wire.activityId),
    measurementCount: wire.measurementCount,
    metricsCount: wire.metricsCount,
    totalMetricsCount: wire.totalMetricsCount,
    detailsAvailable: wire.detailsAvailable,
    metricDescriptors: wire.metricDescriptors,
    metrics: processing.descriptors.decode(descriptors, rows, "activities")
  };
}

export function normalizeActivityPolyline(wire: ActivityPolylineWire): NormalizedActivityPolyline {
  return {
    points: wire.polyline,
    bounds: {
      minLat: wire.minLat,
      maxLat: wire.maxLat,
      minLon: wire.minLon,
      maxLon: wire.maxLon
    }
  };
}

function activityTypeKey(value: Readonly<Record<string, unknown>> | undefined): string | null {
  if (value === undefined) return null;
  const typeKey = value.typeKey;
  return typeof typeKey === "string" ? typeKey : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function optionalIdentifier(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}
