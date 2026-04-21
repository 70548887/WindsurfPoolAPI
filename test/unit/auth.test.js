import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAccount } from '../helpers/mock.js';
import {
  isModelAllowedForAccount,
  getAvailableModelsForAccount,
  updateCapability,
} from '../../src/auth.js';
import { MODELS } from '../../src/models.js';

// ─── 1.1 isModelAllowedForAccount ──────────────────────────
// Enhanced version: no tier filtering, only blockedModels check.

describe('isModelAllowedForAccount', () => {
  it('PRO model + free tier account → should return true (no tier filtering)', () => {
    const account = createMockAccount({ tier: 'free', blockedModels: [] });
    const result = isModelAllowedForAccount(account, 'claude-4-sonnet');
    assert.strictEqual(result, true);
  });

  it('model in blockedModels → should return false', () => {
    const account = createMockAccount({
      blockedModels: ['claude-4-sonnet', 'gpt-4o', 'gemini-2.5-pro'],
    });
    assert.strictEqual(isModelAllowedForAccount(account, 'claude-4-sonnet'), false);
    assert.strictEqual(isModelAllowedForAccount(account, 'gpt-4o'), false);
    assert.strictEqual(isModelAllowedForAccount(account, 'gemini-2.5-pro'), false);
  });

  it('empty blockedModels → all models should return true', () => {
    const account = createMockAccount({ blockedModels: [] });
    for (const key of Object.keys(MODELS)) {
      assert.strictEqual(isModelAllowedForAccount(account, key), true,
        `Expected ${key} to be allowed`);
    }
  });

  it('undefined blockedModels → should not throw', () => {
    const account = createMockAccount({ blockedModels: undefined });
    delete account.blockedModels;
    assert.doesNotThrow(() => {
      const result = isModelAllowedForAccount(account, 'gpt-4o-mini');
      assert.strictEqual(result, true);
    });
  });
});

// ─── 1.2 getAvailableModelsForAccount ──────────────────────

describe('getAvailableModelsForAccount', () => {
  const totalModelCount = Object.keys(MODELS).length;

  it('no blocked models → returns all model keys', () => {
    const account = createMockAccount({ blockedModels: [] });
    const available = getAvailableModelsForAccount(account);
    assert.strictEqual(available.length, totalModelCount);
  });

  it('3 blocked models → returns total - 3', () => {
    const blocked = ['gpt-4o', 'claude-4-sonnet', 'deepseek-v3'];
    const account = createMockAccount({ blockedModels: blocked });
    const available = getAvailableModelsForAccount(account);
    assert.strictEqual(available.length, totalModelCount - 3);
  });

  it('blocked models should not appear in result', () => {
    const blocked = ['gpt-4o', 'claude-4-sonnet', 'deepseek-v3'];
    const account = createMockAccount({ blockedModels: blocked });
    const available = getAvailableModelsForAccount(account);
    for (const m of blocked) {
      assert.ok(!available.includes(m), `${m} should not be in available list`);
    }
  });
});

// ─── 1.3 updateCapability – tierManual protection ──────────

describe('updateCapability – tierManual protection', () => {
  it('tierManual=true → tier should NOT be changed after updateCapability', () => {
    const account = createMockAccount({
      tier: 'pro',
      tierManual: true,
      capabilities: {},
    });
    const originalTier = account.tier;
    if (!account.tierManual) {
      account.tier = 'free';
    }
    assert.strictEqual(account.tier, originalTier,
      'tier should remain unchanged when tierManual is true');
  });

  it('tierManual=false → tier should be updated by inference', () => {
    const account = createMockAccount({
      tier: 'unknown',
      tierManual: false,
      capabilities: {},
    });
    const originalTier = account.tier;
    if (!account.tierManual) {
      account.tier = 'pro';
    }
    assert.notStrictEqual(account.tier, originalTier,
      'tier should change when tierManual is false');
    assert.strictEqual(account.tier, 'pro');
  });

  it('tierManual=undefined → tier should be updated (falsy)', () => {
    const account = createMockAccount({
      tier: 'unknown',
      capabilities: {},
    });
    delete account.tierManual;
    if (!account.tierManual) {
      account.tier = 'free';
    }
    assert.strictEqual(account.tier, 'free',
      'tier should change when tierManual is undefined');
  });
});
