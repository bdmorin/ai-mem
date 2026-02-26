/**
 * Embedding generation for SQLite-native vector search.
 *
 * Uses @huggingface/transformers (transformers.js v3) for in-process inference.
 * Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~23MB download).
 * Lazy-loads on first use. Caches in HuggingFace default cache dir.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

const BATCH_SIZE = 32;

let _pipeline: FeatureExtractionPipeline | null = null;
let _pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Get or create the embedding pipeline (singleton, lazy-loaded).
 * First call downloads the model (~23MB) and warms up ONNX Runtime.
 * Concurrent calls share the same loading promise (no duplicate downloads).
 */
export async function getEmbedder(model: string = DEFAULT_MODEL): Promise<FeatureExtractionPipeline> {
  if (_pipeline) return _pipeline;
  if (_pipelinePromise) return _pipelinePromise;

  _pipelinePromise = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', model, {
        dtype: 'fp32',
      });
      _pipeline = extractor as FeatureExtractionPipeline;
      return _pipeline;
    } catch (err) {
      _pipelinePromise = null;
      throw err;
    }
  })();

  return _pipelinePromise;
}

/**
 * Check if the embedding model is loaded.
 */
export function isModelLoaded(): boolean {
  return _pipeline !== null;
}

/**
 * Embed a single text string. Returns normalized Float32Array (384 dims).
 */
export async function embed(text: string, model?: string): Promise<Float32Array> {
  const extractor = await getEmbedder(model);
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data as Float64Array);
}

/**
 * Embed multiple texts in batches. Returns array of normalized Float32Array.
 */
export async function embedBatch(
  texts: string[],
  model?: string,
  batchSize: number = BATCH_SIZE,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbedder(model);
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });

    // Output shape: [batch_size, dimensions]
    const data = output.data as Float64Array;
    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIMENSIONS;
      const end = start + EMBEDDING_DIMENSIONS;
      results.push(new Float32Array(data.slice(start, end)));
    }
  }

  return results;
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize Buffer from SQLite BLOB back to Float32Array.
 * Copies into a fresh ArrayBuffer to avoid shared-buffer alignment issues.
 */
export function deserializeEmbedding(blob: Buffer): Float32Array {
  const ab = new ArrayBuffer(blob.byteLength);
  const view = new Uint8Array(ab);
  view.set(new Uint8Array(blob));
  return new Float32Array(ab);
}

/**
 * Compute cosine similarity between two vectors.
 * Vectors are assumed normalized (unit length), so cosine = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
