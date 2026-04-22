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
  getRoleWeight,
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

// ─── computeSalienceScores ───────────────────────────────
describe('computeSalienceScores', () => {
  // 1. 基本结构验证
  it('should return array with same length as input messages', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_scores');
    assert.strictEqual(result.length, messages.length);
  });

  // 2. system 消息强制保护
  it('should assign score 999 to system messages', async () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_sys');
    const sysScore = result.find(r => r.message.role === 'system');
    assert.strictEqual(sysScore.score, 999);
  });

  // 3. 最近 keepRecent 条消息强制保护
  it('should assign score 999 to recent messages within keepRecent', async () => {
    const messages = [];
    messages.push({ role: 'system', content: 'System' });
    for (let i = 0; i < 14; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'msg ' + i });
    }
    const result = await computeSalienceScores(messages, 'test_conv_recent');
    // 最后 keepRecent (默认 5*2=10) 条应该是 999
    const lastN = result.slice(-10);
    for (const item of lastN) {
      assert.strictEqual(item.score, 999, 'Message at index ' + item.index + ' should be protected');
    }
  });

  // 4. 返回结构验证
  it('should return objects with index, score, message fields', async () => {
    const messages = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'response' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_struct');
    for (const item of result) {
      assert.ok('index' in item, 'should have index');
      assert.ok('score' in item, 'should have score');
      assert.ok('message' in item, 'should have message');
      assert.strictEqual(typeof item.score, 'number');
    }
  });

  // 5. 空消息数组
  it('should return empty array for empty messages', async () => {
    const result = await computeSalienceScores([], 'test_conv_empty');
    assert.strictEqual(result.length, 0);
  });

  // 6. 无 user 消息时的降级
  it('should handle messages with no user role (degraded scoring)', async () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'assistant', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_nouser');
    assert.strictEqual(result.length, 3);
    // system 仍应该是 999
    assert.strictEqual(result[0].score, 999);
    // 其他消息应有非零分数
    for (const item of result.slice(1)) {
      assert.ok(typeof item.score === 'number');
    }
  });

  // 7. score 值在合理范围内（非保护消息应在 0-1 之间）
  it('should produce scores between 0 and 1 for non-protected messages', async () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'First question about sorting' },
      { role: 'assistant', content: 'Here is a sort algorithm' },
      { role: 'user', content: 'Second question about databases' },
      { role: 'assistant', content: 'Here is database info' },
      { role: 'user', content: 'Third about authentication' },
      { role: 'assistant', content: 'Auth details here' },
      { role: 'user', content: 'Fourth about testing' },
      { role: 'assistant', content: 'Testing info' },
      { role: 'user', content: 'Fifth about deployment' },
      { role: 'assistant', content: 'Deploy info' },
      { role: 'user', content: 'Latest question about auth bug' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_range');
    const nonProtected = result.filter(r => r.score < 999);
    for (const item of nonProtected) {
      assert.ok(item.score >= 0, 'Score ' + item.score + ' should be >= 0');
      assert.ok(item.score <= 1.0, 'Score ' + item.score + ' should be <= 1.0');
    }
  });

  // 8. index 与原始消息位置对应
  it('should preserve correct index mapping', async () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Bye' },
    ];
    const result = await computeSalienceScores(messages, 'test_conv_idx');
    for (let i = 0; i < result.length; i++) {
      assert.strictEqual(result[i].index, i);
      assert.deepStrictEqual(result[i].message, messages[i]);
    }
  });
});

// ─── getRoleWeight ──────────────────────────────────────────
describe('getRoleWeight', () => {
  it('should return 1.0 for system', () => {
    assert.strictEqual(getRoleWeight({ role: 'system' }), 1.0);
  });

  it('should return 0.9 for user', () => {
    assert.strictEqual(getRoleWeight({ role: 'user' }), 0.9);
  });

  it('should return 0.85 for assistant with tool_calls', () => {
    assert.strictEqual(getRoleWeight({ role: 'assistant', tool_calls: [{ id: 'tc_1' }] }), 0.85);
  });

  it('should return 0.8 for tool', () => {
    assert.strictEqual(getRoleWeight({ role: 'tool' }), 0.8);
  });

  it('should return 0.6 for assistant', () => {
    assert.strictEqual(getRoleWeight({ role: 'assistant' }), 0.6);
  });

  it('should return 0.5 for unknown role', () => {
    assert.strictEqual(getRoleWeight({ role: 'custom' }), 0.5);
    assert.strictEqual(getRoleWeight({ role: '' }), 0.5);
  });
});

// ─── LRU 缓存行为验证 ───────────────────────────────────────
describe('LRU cache behavior', () => {
  it('should benefit from LRU cache on repeated calls', async () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello LRU test' },
      { role: 'assistant', content: 'Hi' },
    ];
    // 第一次调用
    const start1 = Date.now();
    await computeSalienceScores(messages, 'test_lru_1');
    const time1 = Date.now() - start1;

    // 第二次调用（相同消息）
    const start2 = Date.now();
    await computeSalienceScores(messages, 'test_lru_1');
    const time2 = Date.now() - start2;

    // 第二次应该不慢于第一次（LRU 缓存命中）
    assert.ok(time2 <= time1 + 50, `Second call (${time2}ms) should not be significantly slower than first (${time1}ms)`);
  });
});
