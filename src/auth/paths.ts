import { resolve } from "node:path";

export const DEFAULT_PRIVATE_DIRECTORY = ".gconnect-private";

export function gconnectPrivateDirectory(cwd: string = process.cwd()): string {
  return resolve(cwd, DEFAULT_PRIVATE_DIRECTORY);
}
