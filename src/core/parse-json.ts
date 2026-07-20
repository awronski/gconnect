import { isSafeNumber, parse as parseLosslessJson } from "lossless-json";

/**
 * Parse Garmin JSON without silently rounding 64-bit identifiers. Safe JSON
 * numbers remain numbers; unsafe numeric lexemes remain decimal strings so a
 * feature decoder can either accept an identifier or reject an invalid metric.
 */
export function parseGarminJson(text: string): unknown {
  return parseLosslessJson(text, undefined, {
    parseNumber: (value) => isSafeNumber(value, { approx: true }) ? Number(value) : value
  });
}
