/**
 * Unit tests for chat utility functions.
 * Uses node:test + node:assert (zero external dependencies).
 *
 * NOTE: Enhanced version does not use _msgChars in nonStreamResponse.
 * The calcMsgChars pure function tests are retained as utility validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Extracted pure function: _msgChars calculation logic ──────────────
function calcMsgChars(messages) {
  return (messages || []).reduce((n, m) => {
    const c = m?.content;
    return n + (typeof c === 'string' ? c.length :
      Array.isArray(c) ? c.reduce((k, p) => k +
        (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0);
  }, 0);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. calcMsgChars — message character counting
// ═══════════════════════════════════════════════════════════════════════

describe('calcMsgChars', () => {
  it('counts plain text message characters', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    assert.equal(calcMsgChars(msgs), 5);
  });

  it('accumulates characters across multiple messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },       // 5
      { role: 'assistant', content: 'world!' },  // 6
      { role: 'user', content: 'ok' },           // 2
    ];
    assert.equal(calcMsgChars(msgs), 13);
  });

  it('counts only text parts in multimodal (array) content', () => {
    const msgs = [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', url: 'data:...' },
      ],
    }];
    assert.equal(calcMsgChars(msgs), 5);
  });

  it('handles multiple text parts in array content', () => {
    const msgs = [{
      role: 'user',
      content: [
        { type: 'text', text: 'abc' },
        { type: 'text', text: 'de' },
      ],
    }];
    assert.equal(calcMsgChars(msgs), 5);
  });

  it('returns 0 for empty messages array', () => {
    assert.equal(calcMsgChars([]), 0);
  });

  it('returns 0 for null input', () => {
    assert.equal(calcMsgChars(null), 0);
  });

  it('returns 0 for undefined input', () => {
    assert.equal(calcMsgChars(undefined), 0);
  });

  it('returns 0 when content is null', () => {
    const msgs = [{ role: 'user', content: null }];
    assert.equal(calcMsgChars(msgs), 0);
  });

  it('returns 0 when content is undefined', () => {
    const msgs = [{ role: 'user' }];
    assert.equal(calcMsgChars(msgs), 0);
  });

  it('returns 0 when content is a number (non-string, non-array)', () => {
    const msgs = [{ role: 'user', content: 42 }];
    assert.equal(calcMsgChars(msgs), 0);
  });

  it('handles mixed plain-text and multimodal messages', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'world' }] },
    ];
    assert.equal(calcMsgChars(msgs), 7);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. nonStreamResponse — verify function exists in source
// ═══════════════════════════════════════════════════════════════════════

describe('nonStreamResponse source verification', () => {
  const chatSrc = readFileSync(
    new URL('../../src/handlers/chat.js', import.meta.url), 'utf8',
  );

  it('nonStreamResponse function exists in chat.js', () => {
    assert.ok(
      chatSrc.includes('nonStreamResponse'),
      'Source should reference nonStreamResponse',
    );
    const sigMatch = /async\s+function\s+nonStreamResponse\s*\(/.test(chatSrc);
    assert.ok(sigMatch, 'nonStreamResponse must be defined as an async function');
  });
});
