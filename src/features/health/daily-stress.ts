import type { FeatureContext } from "../context.js";
import { decodeDescriptorSeriesList, type WireRecord } from "./wire.js";

export function normalizeDailyStress(context: FeatureContext, wire: WireRecord): WireRecord {
  return decodeDescriptorSeriesList(context, wire, "stress", [
    { descriptors: "stressValueDescriptorsDTOList", rows: "stressValuesArray" },
    {
      descriptors: "bodyBatteryValueDescriptorsDTOList",
      rows: "bodyBatteryValuesArray",
      index: "bodyBatteryValueDescriptorIndex",
      key: "bodyBatteryValueDescriptorKey",
      allowStrings: true
    }
  ]);
}
