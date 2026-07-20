#!/usr/bin/env node
import { createApplication } from "../composition.js";
import { isCliError } from "../core/errors.js";
import { renderError } from "../output/output-service.js";

try {
  await createApplication().run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(renderError(error));
  process.exitCode = isCliError(error) ? error.exitCode : 1;
}
