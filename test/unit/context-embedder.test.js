import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentHash,
  cosineSimilarity,
  isModelReady,
  getModelStatus,
  getEmbedding,
  batchEmbed,
  computeSalienceScores,
} from '../../src/context-embedder.js';
import { closeDb } from '../../src/context-db.js';

after(() => {
  closeDb();
});

// ─── contentHash ──────────────────────────────────────────
describe('contentHash', () => {
  it('should return consistent hash for same input', () => {
    const h1 = contentHash('user', 'hello world');
    const h2 = contentHash('user', 'hello world');
    assert.strictEqual(h1, h2);
  });

  it('should return different hash for different role', () => {
    const h1 = contentHash('user', 'hello');
    const h2 = contentHash('assistant', 'hello');
    assert.notStrictEqual(h1, h2);
  });

  it('should truncate content to 500 chars', () => {
    const longText = 'a'.repeat(1000);
    const h1 = contentHash('user', longText);
    const h2 = contentHash('user', longText.slice(0, 500));
    assert.strictEqual(h1, h2);
  });

  it('should handle null/empty content', () => {
    assert.ok(contentHash('user', null));
    assert.ok(contentHash('user', ''));
  });

  it('should return 32 char hex string', () => {
    const h = contentHash('user', 'test');
    assert.strictEqual(h.length, 32);
    assert.match(h, /^[0-9a-f]{32}$/);
  });
});

// ─── cosineSimilarity ─────────────────────────────────────
describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const vec = new Float32Array([1, 2, 3, 4]);
    const sim = cosineSimilarity(vec, vec);
    assert.ok(Math.abs(sim - 1.0) < 0.0001);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim) < 0.0001);
  });

  it('should return -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim - (-1.0)) < 0.0001);
  });

  it('should handle zero vectors gracefully', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });

  it('should handle null/mismatched inputs', () => {
    assert.strictEqual(cosineSimilarity(null, null), 0);
    assert.strictEqual(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0);
  });

  it('should be symmetric: sim(a,b) === sim(b,a)', () => {
    const a = new Float32Array([1, 3, 5]);
    const b = new Float32Array([2, 4, 6]);
    const sim1 = cosineSimilarity(a, b);
    const sim2 = cosineSimilarity(b, a);
    assert.ok(Math.abs(sim1 - sim2) < 0.0001);
  });
});

// ─── isModelReady ─────────────────────────────────────────
describe('isModelReady', () => {
  it('should return boolean', () => {
    assert.strictEqual(typeof isModelReady(), 'boolean');
  });
});

// ─── getModelStatus ───────────────────────────────────────
describe('getModelStatus', () => {
  it('should return status object with status field', () => {
    const status = getModelStatus();
    assert.ok(status.status);
    assert.ok(['ready', 'loading', 'failed', 'idle'].includes(status.status),
      'Unexpected status: ' + status.status);
  });

  it('should include model name when not failed', () => {
    const status = getModelStatus();
    if (status.status !== 'failed') {
      assert.ok(status.model, 'should have model field');
    }
  });
});

// ─── getEmbedding (requires model) ────────────────────────
describe('getEmbedding (requires model)', () => {
  it('should return Float32Array or null', async () => {
    const result = await getEmbedding('hello world');
    if (result !== null) {
      assert.ok(result instanceof Float32Array);
      assert.strictEqual(result.length, 384);
    }
  });
});

// ─── batchEmbed (requires model) ──────────────────────────
describe('batchEmbed (requires model)', () => {
  it('should return array of Float32Array or null', async () => {
    const result = await batchEmbed(['hello', 'world']);
    if (result !== null) {
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 2);
      for (const vec of result) {
        assert.ok(vec instanceof Float32Array);
        assert.strictEqual(vec.length, 384);
      }
    }
  });
});
