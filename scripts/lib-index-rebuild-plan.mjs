export function buildIndexRebuildChunks(total, batchSize, start = 0) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('total must be a non-negative integer');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }
  if (!Number.isSafeInteger(start) || start < 0 || start > total) {
    throw new Error('start must be within total');
  }

  const chunks = [];
  for (let cursor = start; cursor < total; cursor += batchSize) {
    chunks.push([cursor, Math.min(batchSize, total - cursor)]);
  }
  return chunks;
}
