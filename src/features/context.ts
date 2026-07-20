import type { Clock } from "../core/clock.js";
import type { GarminDownloadService } from "../download/contracts.js";
import type { ProcessingToolkit } from "../processing/processing-toolkit.js";

export type { QueryValue } from "../download/contracts.js";

export interface FeatureContext {
  readonly download: GarminDownloadService;
  readonly processing: ProcessingToolkit;
  readonly clock: Clock;
}
