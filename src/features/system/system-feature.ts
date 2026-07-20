import { defineCommand, optionalStringOption } from "../../cli/command-contract.js";
import { GLOBAL_OPTIONS, ROOT_OPTIONS } from "../../cli/global-options.js";
import { CliError } from "../../core/errors.js";
import { result } from "../../core/result.js";
import type { FeatureModule } from "../feature.js";

export interface SystemFeatureOptions {
  readonly contracts: () => readonly import("../../cli/command-contract.js").CommandContract[];
}

export function createSystemFeature(options: SystemFeatureOptions): FeatureModule {
  return {
    id: "system",
    commands: [
      defineCommand({
        contract: {
          id: "system.describe",
          path: ["system", "describe"],
          summary: "Describe the complete CLI contract as JSON.",
          options: {
            command: {
              type: "string",
              description: "Limit output to one command id."
            }
          },
          examples: ["gconnect system describe", "gconnect system describe --command health.sleep"],
          output: { dataset: "system.command-catalogue", shape: "collection" }
        },
        parse: (input) => ({ command: optionalStringOption(input, "command") }),
        execute: async (context, parsed) => {
          const contracts = [...options.contracts()].sort((left, right) => left.id.localeCompare(right.id));
          const selected = parsed.command === undefined
            ? contracts
            : contracts.filter((contract) => contract.id === parsed.command);
          if (parsed.command !== undefined && selected.length === 0) {
            throw new CliError("UNKNOWN_COMMAND_ID", `Unknown command id: ${parsed.command}`, {
              command: parsed.command,
              allowed: contracts.map((contract) => contract.id)
            });
          }
          return result({
            command: "system.describe",
            dataset: "system.command-catalogue",
            generatedAt: context.clock.now().toISOString(),
            sourceEndpoints: [],
            appliedOptions: parsed,
            data: {
              schemaVersion: 1,
              globalOptions: GLOBAL_OPTIONS,
              rootOptions: ROOT_OPTIONS,
              commands: selected
            }
          });
        }
      })
    ]
  };
}
