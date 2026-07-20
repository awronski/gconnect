import { defineCommand } from "../../cli/command-contract.js";
import { result } from "../../core/result.js";
import { mapConcurrentOrdered } from "../../processing/ordered-concurrency.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import { parsePerformanceDateOptions, type PerformanceDateOptions } from "./range.js";
import {
  decodeHeatAltitudeAcclimation,
  decodeMaxMet,
  decodeTrainingLoadBalance,
  decodeTrainingStatus
} from "./wire.js";

export const trainingStatusCommand = defineCommand<PerformanceDateOptions, unknown>({
  contract: {
    id: "performance.training-status",
    path: ["performance", "training-status"],
    summary: "Download daily training status, load focus, VO2 max, and acclimation factors.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect performance training-status --date 2026-07-17",
      "gconnect performance training-status --from 2026-07-01 --to 2026-07-17"
    ],
    output: { dataset: "performance.training-status", shape: "collection" }
  },
  parse: parsePerformanceDateOptions,
  execute: async (context, options) => {
    const endpoints = options.selection.dates.flatMap((date) => Object.values(pathsForDate(date)));
    const days = await mapConcurrentOrdered(options.selection.dates, 2, async (date) => {
      const paths = pathsForDate(date);
      const [trainingStatus, loadBalance, maxMet, acclimation] = await Promise.all([
        context.download.optionalJson({
          path: paths.trainingStatus,
          diPath: `/metrics-service/metrics/trainingstatus/aggregated/${date}`,
          decode: decodeTrainingStatus
        }),
        context.download.optionalJson({ path: paths.loadBalance, decode: decodeTrainingLoadBalance }),
        context.download.optionalJson({ path: paths.maxMet, decode: decodeMaxMet }),
        context.download.optionalJson({ path: paths.acclimation, decode: decodeHeatAltitudeAcclimation })
      ]);
      return { date, trainingStatus, loadBalance, maxMet, heatAltitudeAcclimation: acclimation };
    });
    const data = { days };
    return result({
      command: "performance.training-status",
      dataset: "performance.training-status",
      generatedAt: context.clock.now().toISOString(),
      sourceEndpoints: endpoints,
      appliedOptions: options.selection.appliedOptions,
      raw: options.raw,
      data: options.raw ? data : context.processing.ids.normalizeKnown(data)
    });
  }
});

function pathsForDate(date: string) {
  return {
    trainingStatus: `/gc-api/metrics-service/metrics/trainingstatus/daily/${date}` as const,
    loadBalance: `/gc-api/metrics-service/metrics/trainingloadbalance/latest/${date}` as const,
    maxMet: `/gc-api/metrics-service/metrics/maxmet/latest/${date}` as const,
    acclimation: `/gc-api/metrics-service/metrics/heataltitudeacclimation/latest/${date}` as const
  };
}
