import type { FeatureModule } from "../feature.js";
import { activitiesGetCommand } from "./get.command.js";
import { activitiesListCommand } from "./list.command.js";

export const activitiesFeature: FeatureModule = {
  id: "activities",
  commands: [activitiesListCommand, activitiesGetCommand]
};
