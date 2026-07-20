import { expectArray, expectIdentifier, expectNumber, expectRecord, expectString } from "../../core/json.js";

export type PerformanceWireRecord = Readonly<Record<string, unknown>>;

export function decodeTrainingStatus(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "training status");
  const latest = record.latestTrainingStatusData;
  const devices = record.recordedDevices;
  if (latest === null || devices === null) {
    if (latest !== null || devices !== null) {
      throw new TypeError("training status data and recorded devices must both be null or populated");
    }
    if (record.userId !== null) throw new TypeError("sparse training status.userId must be null");
    expectBoolean(record.showSelector, "sparse training status.showSelector");
    if (record.lastPrimarySyncDate !== null) {
      throw new TypeError("sparse training status.lastPrimarySyncDate must be null");
    }
    return record;
  }
  expectIdentifier(record.userId, "training status.userId");
  expectBoolean(record.showSelector, "training status.showSelector");
  expectString(record.lastPrimarySyncDate, "training status.lastPrimarySyncDate");
  expectRecordMap(latest, "training status.latestTrainingStatusData", validateTrainingStatusItem);
  expectRecordItems(
    expectArray(devices, "training status.recordedDevices"),
    "training status.recordedDevices",
    validateRecordedDevice
  );
  return record;
}

export function decodeTrainingLoadBalance(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "training load balance");
  if (Object.hasOwn(record, "userId")) expectIdentifier(record.userId, "training load balance.userId");
  const balance = expectRecordOrNull(
    record.metricsTrainingLoadBalanceDTOMap,
    "training load balance.metricsTrainingLoadBalanceDTOMap"
  );
  if (balance !== null) {
    expectRecordMap(
      balance,
      "training load balance.metricsTrainingLoadBalanceDTOMap",
      validateTrainingLoadBalanceItem
    );
  }
  const devices = expectArrayOrNull(record.recordedDevices, "training load balance.recordedDevices");
  if (devices !== null) expectRecordItems(devices, "training load balance.recordedDevices", validateRecordedDevice);
  return record;
}

export function decodeMaxMet(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "max met");
  expectIdentifier(record.userId, "max met.userId");
  expectRecordOrNull(record.cycling, "max met.cycling");
  const generic = expectRecordOrNull(record.generic, "max met.generic");
  if (generic !== null) validateGenericMaxMet(generic, "max met.generic");
  const acclimation = expectRecordOrNull(record.heatAltitudeAcclimation, "max met.heatAltitudeAcclimation");
  if (acclimation !== null) validateEmbeddedAcclimation(acclimation, "max met.heatAltitudeAcclimation");
  return record;
}

export function decodeHeatAltitudeAcclimation(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "heat altitude acclimation");
  expectString(record.calendarDate, "heat altitude acclimation.calendarDate");
  expectNumber(record.heatAcclimationPercentage, "heat altitude acclimation.heatAcclimationPercentage");
  expectNumber(record.altitudeAcclimation, "heat altitude acclimation.altitudeAcclimation");
  return record;
}

export function decodeDailyHrv(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "daily HRV");
  validateHrvSummary(expectRecord(record.hrvSummary, "daily HRV.hrvSummary"), "daily HRV.hrvSummary");
  expectRecordItems(
    expectArray(record.hrvReadings, "daily HRV.hrvReadings"),
    "daily HRV.hrvReadings",
    validateHrvReading
  );
  return record;
}

export function decodeHrvRange(input: unknown): PerformanceWireRecord {
  const record = expectRecord(input, "HRV range");
  expectRecordItems(
    expectArray(record.hrvSummaries, "HRV range.hrvSummaries"),
    "HRV range.hrvSummaries",
    validateHrvSummary
  );
  return record;
}

function expectRecordOrNull(value: unknown, name: string): Record<string, unknown> | null {
  return value === null ? null : expectRecord(value, name);
}

function expectArrayOrNull(value: unknown, name: string): readonly unknown[] | null {
  return value === null ? null : expectArray(value, name);
}

function expectRecordMap(
  value: unknown,
  name: string,
  validate: (record: Record<string, unknown>, name: string) => void = () => undefined
): void {
  const record = expectRecord(value, name);
  for (const [key, item] of Object.entries(record)) {
    const itemName = `${name}.${key}`;
    validate(expectRecord(item, itemName), itemName);
  }
}

function expectRecordItems(
  items: readonly unknown[],
  name: string,
  validate: (record: Record<string, unknown>, name: string) => void = () => undefined
): void {
  items.forEach((item, index) => {
    const itemName = `${name}[${index}]`;
    validate(expectRecord(item, itemName), itemName);
  });
}

function validateRecordedDevice(record: Record<string, unknown>, name: string): void {
  expectIdentifier(record.deviceId, `${name}.deviceId`);
  expectString(record.deviceName, `${name}.deviceName`);
  expectString(record.imageURL, `${name}.imageURL`);
  expectNumber(record.category, `${name}.category`);
}

function validateTrainingStatusItem(record: Record<string, unknown>, name: string): void {
  expectString(record.calendarDate, `${name}.calendarDate`);
  expectString(record.sinceDate, `${name}.sinceDate`);
  expectNumber(record.trainingStatus, `${name}.trainingStatus`);
  expectNumber(record.timestamp, `${name}.timestamp`);
  expectIdentifier(record.deviceId, `${name}.deviceId`);
  expectNumber(record.fitnessTrend, `${name}.fitnessTrend`);
  expectString(record.fitnessTrendSport, `${name}.fitnessTrendSport`);
  expectString(record.trainingStatusFeedbackPhrase, `${name}.trainingStatusFeedbackPhrase`);
  expectBoolean(record.trainingPaused, `${name}.trainingPaused`);
  expectBoolean(record.primaryTrainingDevice, `${name}.primaryTrainingDevice`);
  expectRecord(record.acuteTrainingLoadDTO, `${name}.acuteTrainingLoadDTO`);
}

function validateTrainingLoadBalanceItem(record: Record<string, unknown>, name: string): void {
  expectString(record.calendarDate, `${name}.calendarDate`);
  expectIdentifier(record.deviceId, `${name}.deviceId`);
  expectBoolean(record.primaryTrainingDevice, `${name}.primaryTrainingDevice`);
}

function validateGenericMaxMet(record: Record<string, unknown>, name: string): void {
  expectString(record.calendarDate, `${name}.calendarDate`);
  expectNumberOrNull(record.maxMetCategory, `${name}.maxMetCategory`);
  expectNumberOrNull(record.vo2MaxPreciseValue, `${name}.vo2MaxPreciseValue`);
  expectNumberOrNull(record.vo2MaxValue, `${name}.vo2MaxValue`);
}

function validateEmbeddedAcclimation(record: Record<string, unknown>, name: string): void {
  expectString(record.calendarDate, `${name}.calendarDate`);
  expectNumberOrNull(record.heatAcclimationPercentage, `${name}.heatAcclimationPercentage`);
  expectNumberOrNull(record.altitudeAcclimation, `${name}.altitudeAcclimation`);
}

function validateHrvSummary(record: Record<string, unknown>, name: string): void {
  expectRecord(record.baseline, `${name}.baseline`);
  expectString(record.calendarDate, `${name}.calendarDate`);
  expectString(record.createTimeStamp, `${name}.createTimeStamp`);
  expectString(record.feedbackPhrase, `${name}.feedbackPhrase`);
  expectString(record.status, `${name}.status`);
  expectNumber(record.lastNight5MinHigh, `${name}.lastNight5MinHigh`);
  expectNumber(record.lastNightAvg, `${name}.lastNightAvg`);
  expectNumber(record.weeklyAvg, `${name}.weeklyAvg`);
}

function validateHrvReading(record: Record<string, unknown>, name: string): void {
  expectNumber(record.hrvValue, `${name}.hrvValue`);
  expectString(record.readingTimeGMT, `${name}.readingTimeGMT`);
  expectString(record.readingTimeLocal, `${name}.readingTimeLocal`);
}

function expectNumberOrNull(value: unknown, name: string): void {
  if (value !== null) expectNumber(value, name);
}

function expectBoolean(value: unknown, name: string): void {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}
