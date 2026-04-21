import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEPRECATED_MODEL_UIDS } from '../helpers/mock.js';
import { MODELS } from '../../src/models.js';

const KNOWN_PROVIDERS = [
  'anthropic', 'openai', 'google', 'deepseek',
  'xai', 'windsurf', 'alibaba', 'moonshot', 'zhipu', 'minimax',
];

// ─── 2.1 Model UID validity ───────────────────────────────

describe('Model UID validity', () => {
  it('no model should use a deprecated modelUid', () => {
    const deprecated = new Set(DEPRECATED_MODEL_UIDS);
    for (const [key, info] of Object.entries(MODELS)) {
      if (info.modelUid) {
        assert.ok(!deprecated.has(info.modelUid),
          `${key} uses deprecated modelUid "${info.modelUid}"`);
      }
    }
  });
});

// ─── 2.2 claude-4-sonnet mapping verification ─────────────
// After Task 9 bug fixes, these should use the correct non-deprecated UIDs.

describe('claude-4-sonnet family mapping', () => {
  it('claude-4-sonnet → MODEL_PRIVATE_2', () => {
    assert.strictEqual(MODELS['claude-4-sonnet'].modelUid, 'MODEL_PRIVATE_2');
  });

  it('claude-4-sonnet-thinking → MODEL_PRIVATE_3', () => {
    assert.strictEqual(MODELS['claude-4-sonnet-thinking'].modelUid, 'MODEL_PRIVATE_3');
  });

  it('claude-4-opus → MODEL_CLAUDE_4_5_OPUS', () => {
    assert.strictEqual(MODELS['claude-4-opus'].modelUid, 'MODEL_CLAUDE_4_5_OPUS');
  });

  it('claude-4-opus-thinking → MODEL_CLAUDE_4_5_OPUS_THINKING', () => {
    assert.strictEqual(MODELS['claude-4-opus-thinking'].modelUid, 'MODEL_CLAUDE_4_5_OPUS_THINKING');
  });

  it('claude-4.1-opus → MODEL_CLAUDE_4_5_OPUS', () => {
    assert.strictEqual(MODELS['claude-4.1-opus'].modelUid, 'MODEL_CLAUDE_4_5_OPUS');
  });

  it('claude-4.1-opus-thinking → MODEL_CLAUDE_4_5_OPUS_THINKING', () => {
    assert.strictEqual(MODELS['claude-4.1-opus-thinking'].modelUid, 'MODEL_CLAUDE_4_5_OPUS_THINKING');
  });
});

// ─── 2.3 Model catalog completeness ───────────────────────

describe('Model catalog completeness', () => {
  it('every model must have name, provider, enumValue, modelUid fields', () => {
    for (const [key, info] of Object.entries(MODELS)) {
      assert.ok(info.name !== undefined, `${key} missing "name"`);
      assert.ok(info.provider !== undefined, `${key} missing "provider"`);
      assert.ok(info.enumValue !== undefined, `${key} missing "enumValue"`);
      // modelUid may be absent for legacy enum-only models, verify it exists as a key
      assert.ok('modelUid' in info || info.enumValue > 0,
        `${key} must have modelUid or a positive enumValue`);
    }
  });

  it('name field should match the key', () => {
    for (const [key, info] of Object.entries(MODELS)) {
      assert.strictEqual(info.name, key,
        `Model "${key}" has mismatched name "${info.name}"`);
    }
  });

  it('provider should be a known value', () => {
    const known = new Set(KNOWN_PROVIDERS);
    for (const [key, info] of Object.entries(MODELS)) {
      assert.ok(known.has(info.provider),
        `${key} has unknown provider "${info.provider}"`);
    }
  });
});
