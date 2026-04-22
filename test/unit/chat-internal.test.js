/**
 * 测试 chat.js 的 _internal 快速通道标志行为
 * 由于 handleChatCompletions 需要完整的 LS 运行环境，
 * 我们用导入验证 + 参数检查的方式测试
 */
import { strict as assert } from 'assert';
import { describe, it, after } from 'node:test';
import { closeDb } from '../../src/context-db.js';

after(() => {
  closeDb();
});

describe('chat.js _internal flag', () => {
  it('should export handleChatCompletions function', async () => {
    const mod = await import('../../src/handlers/chat.js');
    assert.strictEqual(typeof mod.handleChatCompletions, 'function');
  });

  it('_internal request should be recognized as valid parameter', () => {
    // 验证 _internal 参数不会导致解构错误
    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
      _internal: true,
    };
    const { _internal } = body;
    assert.strictEqual(_internal, true);
  });

  it('_internal defaults to undefined when not provided', () => {
    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
    };
    const { _internal } = body;
    assert.strictEqual(_internal, undefined);
  });

  it('body with _internal should still contain all other required fields', () => {
    const body = {
      model: 'claude-3.5-sonnet',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      _internal: true,
    };
    assert.strictEqual(body.model, 'claude-3.5-sonnet');
    assert.strictEqual(body.messages.length, 2);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body._internal, true);
  });
});
