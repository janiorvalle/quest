export function allocateDisplayId(existingIds: readonly number[]): number {
  let maximum = 0;
  for (const id of existingIds) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new RangeError(`display id must be a positive safe integer: ${id}`);
    }
    maximum = Math.max(maximum, id);
  }

  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("display id space exhausted");
  }
  return maximum + 1;
}
