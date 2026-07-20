import type { FeatureModule } from "../feature.js";
import { hrvCommand } from "./hrv.js";
import { trainingStatusCommand } from "./training-status.js";

export const performanceFeature: FeatureModule = {
  id: "performance",
  commands: [trainingStatusCommand, hrvCommand]
};
