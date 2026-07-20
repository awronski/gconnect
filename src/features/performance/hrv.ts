import { defineCommand } from "../../cli/command-contract.js";
import { result } from "../../core/result.js";
import { DATE_SELECTOR_OPTIONS, DATE_SELECTOR_RULES } from "../date-selector.js";
import { parsePerformanceDateOptions, type PerformanceDateOptions } from "./range.js";
import { decodeDailyHrv, decodeHrvRange } from "./wire.js";

export const hrvCommand = defineCommand<PerformanceDateOptions, unknown>({
  contract: {
    id: "performance.hrv",
    path: ["performance", "hrv"],
    summary: "Download HRV status and overnight readings for one day or a summary date range.",
    options: DATE_SELECTOR_OPTIONS,
    rules: DATE_SELECTOR_RULES,
    examples: [
      "gconnect performance hrv --date 2026-07-17",
      "gconnect performance hrv --from 2026-07-01 --to 2026-07-17"
    ],
    output: { dataset: "performance.hrv", shape: "document" },
    limitations: ["The range endpoint returns daily summaries; use --date for intranight readings."]
  },
  parse: parsePerformanceDateOptions,
  execute: async (context, options) => {
    const applied = options.selection.appliedOptions;
    if ("date" in applied) {
      const path = `/gc-api/hrv-service/hrv/${applied.date}` as const;
      const payload = await context.download.optionalJson({ path, decode: decodeDailyHrv });
      const data = { date: applied.date, payload };
      return result({
        command: "performance.hrv",
        dataset: "performance.hrv",
        generatedAt: context.clock.now().toISOString(),
        sourceEndpoints: [path],
        appliedOptions: applied,
        raw: options.raw,
        data: options.raw ? data : context.processing.ids.normalizeKnown(data)
      });
    }
    const path = `/gc-api/hrv-service/hrv/daily/${applied.from}/${applied.to}` as const;
    const payload = await context.download.optionalJson({ path, decode: decodeHrvRange });
    const data = { from: applied.from, to: applied.to, payload };
    return result({
      command: "performance.hrv",
      dataset: "performance.hrv",
      generatedAt: context.clock.now().toISOString(),
      sourceEndpoints: [path],
      appliedOptions: applied,
      raw: options.raw,
      data: options.raw ? data : context.processing.ids.normalizeKnown(data)
    });
  }
});
