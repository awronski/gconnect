import { CliError } from "./errors.js";

export async function readTextLimited(response: Response, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    await cancelBody(response.body);
    throw responseTooLarge(maximumBytes);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await cancelReader(reader);
      throw responseTooLarge(maximumBytes);
    }
    chunks.push(next.value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function responseTooLarge(maximumBytes: number): CliError {
  return new CliError("RESPONSE_TOO_LARGE", "Garmin response exceeded the configured size limit", {
    maximumBytes
  }, 1);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // The size-limit error is the actionable failure; cancellation is best effort.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The size-limit error is the actionable failure; cancellation is best effort.
  }
}
