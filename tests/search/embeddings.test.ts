import { describe, test, expect, beforeAll } from 'bun:test';
import {
  getEmbedder,
  embed,
  embedBatch,
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
} from '../../src/services/search/embeddings';

describe('embeddings', () => {
  // Model loading is slow (~2s first time), so we load once
  beforeAll(async () => {
    await getEmbedder();
  }, 30_000);

  test('embed() returns Float32Array of expected dimensions', async () => {
    const result = await embed('hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  test('embed() returns normalized vectors (unit length)', async () => {
    const result = await embed('test input');
    const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  test('embedBatch() returns array of Float32Array', async () => {
    const results = await embedBatch(['hello', 'world', 'test']);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(384);
    }
  });

  test('serialize/deserialize roundtrips correctly', () => {
    const original = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const blob = serializeEmbedding(original);
    expect(blob).toBeInstanceOf(Buffer);

    const restored = deserializeEmbedding(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]);
    }
  });

  test('cosineSimilarity() returns 1.0 for identical vectors', () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('cosineSimilarity() returns ~0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.01);
  });

  test('similar texts have higher cosine similarity than unrelated', async () => {
    const authEmbed = await embed('user authentication and login');
    const oauthEmbed = await embed('OAuth token validation');
    const cookingEmbed = await embed('best recipe for chocolate cake');

    const authOauthSim = cosineSimilarity(authEmbed, oauthEmbed);
    const authCookingSim = cosineSimilarity(authEmbed, cookingEmbed);

    expect(authOauthSim).toBeGreaterThan(authCookingSim);
  });
});
