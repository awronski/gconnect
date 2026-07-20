import type { FeatureModule } from "../feature.js";
import { bodyBatteryCommand } from "./body-battery.js";
import { heartRateCommand } from "./heart-rate.js";
import { pulseOxCommand } from "./pulse-ox.js";
import { respirationCommand } from "./respiration.js";
import { sleepCommand } from "./sleep.js";
import { stressCommand } from "./stress.js";

export const healthFeature: FeatureModule = {
  id: "health",
  commands: [
    sleepCommand,
    pulseOxCommand,
    respirationCommand,
    heartRateCommand,
    stressCommand,
    bodyBatteryCommand
  ]
};
