import { CliError } from "../core/errors.js";

export async function mapConcurrentOrdered<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>
): Promise<readonly Output[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new CliError("INTERNAL_CONTRACT_ERROR", "Concurrency must be a positive integer", { concurrency }, 1);
  }
  const results: Output[] = new Array(inputs.length);
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (!failed && cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      const input = inputs[index];
      if (input === undefined) continue;
      try {
        results[index] = await operation(input, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejection = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (rejection !== undefined) throw rejection.reason;
  return results;
}
