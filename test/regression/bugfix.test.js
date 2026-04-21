/**
 * Regression tests for critical bug fixes in WindsurfPoolAPI (enhanced version).
 * Adapted from original WindsurfAPI 5-bug regression suite.
 * Uses node:test + node:assert (zero external dependencies).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEPRECATED_MODEL_UIDS } from '../helpers/mock.js';
import { MODELS } from '../../src/models.js';
import { isModelAllowedForAccount } from '../../src/auth.js';
import { buildMetadata } from '../../src/windsurf.js';

// Pre-load source files for text analysis
const chatSrc = readFileSync(
  new URL('../../src/handlers/chat.js', import.meta.url), 'utf8',
);
const langserverSrc = readFileSync(
  new URL('../../src/langserver.js', import.meta.url), 'utf8',
);
const windsurfSrc = readFileSync(
  new URL('../../src/windsurf.js', import.meta.url), 'utf8',
);

// ═══════════════════════════════════════════════════════════════════════
// BUG-1: nonStreamResponse must be a proper async function
// ═══════════════════════════════════════════════════════════════════════

describe('BUG-1 regression: nonStreamResponse function integrity', () => {
  it('nonStreamResponse is defined as an async function', () => {
    const sigMatch = /async\s+function\s+nonStreamResponse\s*\(/.test(chatSrc);
    assert.ok(sigMatch, 'nonStreamResponse must be defined as an async function');
  });

  it('nonStreamResponse is invoked in the chat handler', () => {
    const callMatch = /nonStreamResponse\s*\(/.test(chatSrc);
    assert.ok(callMatch, 'nonStreamResponse must be called in chat handler');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-2: LS pool architecture (enhanced version uses pool, not restart)
// ═══════════════════════════════════════════════════════════════════════

describe('BUG-2 regression: LS pool architecture', () => {
  it('ensureLs function is exported', () => {
    assert.ok(
      langserverSrc.includes('export async function ensureLs'),
      'langserver.js must export ensureLs',
    );
  });

  it('LS pool map exists', () => {
    assert.ok(
      langserverSrc.includes('_pool'),
      'langserver.js must define a _pool Map for LS instances',
    );
  });

  it('LS handles exit event and cleans up pool entry', () => {
    assert.ok(
      langserverSrc.includes("'exit'"),
      'LS must handle exit events',
    );
    assert.ok(
      langserverSrc.includes('_pool.delete'),
      'LS exit handler must clean up pool entry',
    );
  });

  it('waitPortReady function exists for health checking', () => {
    assert.ok(
      langserverSrc.includes('waitPortReady'),
      'langserver.js must define waitPortReady for LS health checking',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-3: PRO models not blocked by local tier filter
// ═══════════════════════════════════════════════════════════════════════

describe('BUG-3 regression: PRO models not locally intercepted', () => {
  it('free-tier account can access claude-4-sonnet (no local block)', () => {
    const account = { tier: 'free', blockedModels: [] };
    assert.equal(isModelAllowedForAccount(account, 'claude-4-sonnet'), true);
  });

  it('free-tier account can access claude-opus-4.6', () => {
    const account = { tier: 'free', blockedModels: [] };
    assert.equal(isModelAllowedForAccount(account, 'claude-opus-4.6'), true);
  });

  it('free-tier account can access gpt-5', () => {
    const account = { tier: 'free', blockedModels: [] };
    assert.equal(isModelAllowedForAccount(account, 'gpt-5'), true);
  });

  it('explicitly blocked model is still blocked', () => {
    const account = { tier: 'pro', blockedModels: ['claude-4-sonnet'] };
    assert.equal(isModelAllowedForAccount(account, 'claude-4-sonnet'), false);
  });

  it('non-blocked model on same account is allowed', () => {
    const account = { tier: 'pro', blockedModels: ['claude-4-sonnet'] };
    assert.equal(isModelAllowedForAccount(account, 'gpt-4o'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-4: Model UID mapping — deprecated UIDs removed
// ═══════════════════════════════════════════════════════════════════════

describe('BUG-4 regression: model UID mapping', () => {
  it('no model in MODELS uses a deprecated UID', () => {
    for (const [key, info] of Object.entries(MODELS)) {
      if (info.modelUid) {
        assert.ok(
          !DEPRECATED_MODEL_UIDS.includes(info.modelUid),
          `Model "${key}" still uses deprecated UID "${info.modelUid}"`,
        );
      }
    }
  });

  it('claude-4-sonnet uses MODEL_PRIVATE_2', () => {
    assert.equal(MODELS['claude-4-sonnet'].modelUid, 'MODEL_PRIVATE_2');
  });

  it('claude-4-sonnet-thinking uses MODEL_PRIVATE_3', () => {
    assert.equal(MODELS['claude-4-sonnet-thinking'].modelUid, 'MODEL_PRIVATE_3');
  });

  it('claude-4-opus uses MODEL_CLAUDE_4_5_OPUS', () => {
    assert.equal(MODELS['claude-4-opus'].modelUid, 'MODEL_CLAUDE_4_5_OPUS');
  });

  it('claude-4-opus-thinking uses MODEL_CLAUDE_4_5_OPUS_THINKING', () => {
    assert.equal(MODELS['claude-4-opus-thinking'].modelUid, 'MODEL_CLAUDE_4_5_OPUS_THINKING');
  });

  it('claude-4.1-opus uses MODEL_CLAUDE_4_5_OPUS', () => {
    assert.equal(MODELS['claude-4.1-opus'].modelUid, 'MODEL_CLAUDE_4_5_OPUS');
  });

  it('claude-4.1-opus-thinking uses MODEL_CLAUDE_4_5_OPUS_THINKING', () => {
    assert.equal(MODELS['claude-4.1-opus-thinking'].modelUid, 'MODEL_CLAUDE_4_5_OPUS_THINKING');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-5: Version number in buildMetadata
// ═══════════════════════════════════════════════════════════════════════

describe('BUG-5 regression: version number', () => {
  it('buildMetadata has a version parameter with default', () => {
    const sigMatch = windsurfSrc.match(
      /export\s+function\s+buildMetadata\s*\(\s*apiKey\s*,\s*version\s*=\s*'([^']+)'/,
    );
    assert.ok(sigMatch, 'buildMetadata must have a version parameter with default');
    assert.equal(sigMatch[1], '2.0.63');
  });

  it('buildMetadata is callable and returns a Buffer', () => {
    const result = buildMetadata('test-key');
    assert.ok(Buffer.isBuffer(result), 'buildMetadata must return a Buffer');
  });

  it('buildMetadata output contains the version string', () => {
    const buf = buildMetadata('test-key');
    const str = buf.toString('utf8');
    assert.ok(str.includes('2.0.63'), 'Default version 2.0.63 must appear in output');
  });
});
