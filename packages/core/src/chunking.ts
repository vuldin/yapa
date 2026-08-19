import { CHUNK_SIZE, CHUNK_OVERLAP } from './config.js';

export interface Chunk {
  content: string;
  index: number;
  total: number;
}

/**
 * Split text into overlapping chunks.
 * Returns a single chunk if text fits within CHUNK_SIZE.
 */
export function chunkText(text: string): Chunk[] {
  if (text.length <= CHUNK_SIZE) {
    return [{ content: text, index: 0, total: 1 }];
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push({ content: text.slice(start, end), index: chunks.length, total: 0 });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  // Fill in total count
  for (const chunk of chunks) {
    chunk.total = chunks.length;
  }

  return chunks;
}
