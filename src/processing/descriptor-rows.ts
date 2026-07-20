import { ProtocolChangedError } from "../core/errors.js";

export interface IndexedDescriptor {
  readonly index: number;
  readonly key: string;
}

export type DescriptorValue = number | string | null;
export type DecodedDescriptorRow<Value extends DescriptorValue = DescriptorValue> = Readonly<Record<string, Value | null>>;

export function decodeDescriptorRows<Value extends DescriptorValue>(
  descriptors: readonly IndexedDescriptor[],
  rows: readonly (readonly Value[])[],
  feature: string
): readonly DecodedDescriptorRow<Value>[] {
  const indexes = new Set<number>();
  const keys = new Set<string>();
  for (const descriptor of descriptors) {
    if (!Number.isSafeInteger(descriptor.index) || descriptor.index < 0 || descriptor.key.length === 0) {
      throw new ProtocolChangedError({ feature, issue: "invalid descriptor", descriptor });
    }
    if (indexes.has(descriptor.index) || keys.has(descriptor.key)) {
      throw new ProtocolChangedError({ feature, issue: "duplicate descriptor", descriptor });
    }
    indexes.add(descriptor.index);
    keys.add(descriptor.key);
  }
  if (descriptors.length === 0 && rows.some((row) => row.length > 0)) {
    throw new ProtocolChangedError({
      feature,
      issue: "descriptor rows contain values without descriptors"
    });
  }
  const highestIndex = descriptors.reduce((highest, descriptor) => Math.max(highest, descriptor.index), -1);
  return rows.map((row, rowIndex) => {
    if (row.length <= highestIndex) {
      throw new ProtocolChangedError({
        feature,
        issue: "descriptor row is shorter than required",
        rowIndex,
        expectedColumns: highestIndex + 1,
        actualColumns: row.length
      });
    }
    return Object.freeze(Object.fromEntries(descriptors.map(({ index, key }) => [key, row[index] ?? null])));
  });
}
