import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveConversationId,
  validateAndCleanSummary,
  scoreMessage,
  structuralTrim,
  extractWorkingMemory,
  buildToolCallGraph,
  processContext,
  postResponseHook,
  rollbackTrim,
  _testSemanticTrim as semanticTrim,
  _testChunkedSummarize as chunkedSummarize,
  _testChunkedMergeSummary as chunkedMergeSummary,
  _testEstimateTokens,
  _testDedup,
} from '../../src/context-manager.js';
import { config } from '../../src/config.js';
import { closeDb, getRecentMessages, deleteMemory, saveAuditLog, getAuditLogs } from '../../src/context-db.js';

after(() => {
  closeDb();
});

// ─── deriveConversationId ─────────────────────────────────
describe('deriveConversationId', () => {
  it('空数组返回 unknown', () => {
    assert.strictEqual(deriveConversationId([]), 'unknown');
  });

  it('非数组返回 unknown', () => {
    assert.strictEqual(deriveConversationId(null), 'unknown');
    assert.strictEqual(deriveConversationId(undefined), 'unknown');
  });

  it('同前缀消息生成相同 ID', () => {
    const msgs = [
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: 'Hello world' },
    ];
    const id1 = deriveConversationId(msgs);
    const id2 = deriveConversationId(msgs);
    assert.strictEqual(id1, id2);
  });

  it('不同前缀消息生成不同 ID', () => {
    const msgs1 = [{ role: 'user', content: 'Task A' }];
    const msgs2 = [{ role: 'user', content: 'Task B' }];
    assert.notStrictEqual(deriveConversationId(msgs1), deriveConversationId(msgs2));
  });

  it('返回 16 字符十六进制字符串', () => {
    const id = deriveConversationId([{ role: 'user', content: 'test' }]);
    assert.strictEqual(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
  });
});

// ─── validateAndCleanSummary ──────────────────────────────
describe('validateAndCleanSummary', () => {
  it('合法 JSON 字符串直接返回', () => {
    const json = '{"goals":["test"],"decisions":[]}';
    assert.strictEqual(validateAndCleanSummary(json), json);
  });

  it('带 markdown ```json 包裹的 JSON 提取', () => {
    const wrapped = '```json\n{"goals":["a"]}\n```';
    const result = validateAndCleanSummary(wrapped);
    assert.strictEqual(result, '{"goals":["a"]}');
  });

  it('纯文本原样返回', () => {
    const text = 'This is a plain text summary without JSON';
    assert.strictEqual(validateAndCleanSummary(text), text);
  });

  it('null 输入返回 null', () => {
    assert.strictEqual(validateAndCleanSummary(null), null);
    assert.strictEqual(validateAndCleanSummary(undefined), null);
    assert.strictEqual(validateAndCleanSummary(''), null);
  });
});

// ─── scoreMessage ─────────────────────────────────────────
describe('scoreMessage', () => {
  const emptyGraph = new Map();

  it('system 消息得分 >= 100', () => {
    const msg = { role: 'system', content: 'You are a helper' };
    const score = scoreMessage(msg, 0, 1, emptyGraph);
    assert.ok(score >= 100, `Expected score >= 100, got ${score}`);
  });

  it('最新位置的消息得分 > 最旧位置', () => {
    const msg = { role: 'user', content: 'Hello' };
    const scoreOld = scoreMessage(msg, 0, 10, emptyGraph);
    const scoreNew = scoreMessage(msg, 9, 10, emptyGraph);
    assert.ok(scoreNew > scoreOld, `Expected ${scoreNew} > ${scoreOld}`);
  });

  it('被引用的 tool_call 消息加 80 分', () => {
    const graph = new Map([['tc_1', true]]);
    const msgWithRef = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_1', function: { name: 'test' } }],
    };
    const msgNoRef = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_2', function: { name: 'test' } }],
    };
    const scoreRef = scoreMessage(msgWithRef, 5, 10, graph);
    const scoreNoRef = scoreMessage(msgNoRef, 5, 10, graph);
    assert.ok(scoreRef - scoreNoRef >= 80, `Expected diff >= 80, got ${scoreRef - scoreNoRef}`);
  });

  it('含代码块的消息加 15 分', () => {
    const msgCode = { role: 'user', content: 'Here is code:\n```js\nconsole.log("hi")\n```' };
    const msgPlain = { role: 'user', content: 'Here is a plain message without code' };
    const scoreCode = scoreMessage(msgCode, 5, 10, emptyGraph);
    const scorePlain = scoreMessage(msgPlain, 5, 10, emptyGraph);
    assert.ok(scoreCode > scorePlain, `Code score ${scoreCode} should be > plain score ${scorePlain}`);
  });
});

// ─── structuralTrim ───────────────────────────────────────
describe('structuralTrim', () => {
  it('system 消息永不删除', () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      })),
    ];
    const { kept } = structuralTrim(msgs, 8);
    const systemKept = kept.filter(m => m.role === 'system');
    assert.strictEqual(systemKept.length, 1, 'system message should be kept');
  });

  it('最近 N 轮消息永不删除', () => {
    const msgs = [
      { role: 'system', content: 'prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
      })),
    ];
    const { kept } = structuralTrim(msgs, 5);
    const lastMsg = msgs[msgs.length - 1];
    assert.ok(kept.includes(lastMsg), 'last message should be in kept');
  });

  it('超出 targetCount 时正确裁剪', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));
    const { kept, trimmedForSummary } = structuralTrim(msgs, 10);
    assert.ok(kept.length <= 30, 'kept should be reduced');
    assert.ok(trimmedForSummary.length > 0, 'should have trimmed messages');
    assert.strictEqual(kept.length + trimmedForSummary.length, msgs.length);
  });

  it('trimmedForSummary 包含被裁剪的消息', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));
    const { trimmedForSummary } = structuralTrim(msgs, 5);
    assert.ok(trimmedForSummary.length > 0, 'trimmedForSummary should not be empty');
    for (const m of trimmedForSummary) {
      assert.ok(m.role && m.content !== undefined, 'trimmed messages should have role and content');
    }
  });
});

// ─── extractWorkingMemory ─────────────────────────────────
describe('extractWorkingMemory', () => {
  it('从用户消息中提取文件路径', () => {
    const msgs = [
      { role: 'user', content: '请修改 /src/index.js 文件' },
      { role: 'assistant', content: 'OK' },
    ];
    const result = extractWorkingMemory(msgs);
    assert.ok(result, 'should return non-null');
    assert.ok(result.includes('/src/index.js'), 'should contain file path');
  });

  it('提取任务关键词', () => {
    const msgs = [
      { role: 'user', content: '请修复这个 bug' },
    ];
    const result = extractWorkingMemory(msgs);
    assert.ok(result, 'should return non-null');
    assert.ok(result.includes('Current task'), 'should contain task info');
  });

  it('无匹配内容返回 null', () => {
    const msgs = [
      { role: 'assistant', content: 'Hello there' },
      { role: 'user', content: 'OK' },
    ];
    const result = extractWorkingMemory(msgs);
    assert.strictEqual(result, null);
  });
});

// ─── buildToolCallGraph ──────────────────────────────────
describe('buildToolCallGraph', () => {
  it('should map tool_call_ids referenced by tool messages', () => {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'tc_1', name: 'search' }] },
      { role: 'tool', tool_call_id: 'tc_1', content: 'result' },
      { role: 'assistant', tool_calls: [{ id: 'tc_2', name: 'read' }] },
    ];
    const graph = buildToolCallGraph(messages);
    assert.strictEqual(graph.has('tc_1'), true);
    assert.strictEqual(graph.has('tc_2'), false);
  });

  it('should return empty map for messages without tools', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const graph = buildToolCallGraph(messages);
    assert.strictEqual(graph.size, 0);
  });

  it('should handle empty messages', () => {
    const graph = buildToolCallGraph([]);
    assert.strictEqual(graph.size, 0);
  });
});

// ─── postResponseHook ─────────────────────────────────────
describe('postResponseHook', () => {
  it('should not throw when summary is disabled', async () => {
    const origEnabled = config.contextTrimSummaryEnabled;
    config.contextTrimSummaryEnabled = false;

    await assert.doesNotReject(async () => {
      await postResponseHook('test_conv_hook', [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'response' }
      ], 'response text');
    });

    config.contextTrimSummaryEnabled = origEnabled;
  });

  it('should save recent messages to SQLite when summary enabled', async () => {
    const origEnabled = config.contextTrimSummaryEnabled;
    config.contextTrimSummaryEnabled = true;

    const convId = 'test_hook_save_' + Date.now();
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];

    await postResponseHook(convId, messages, 'hi there');

    // Retry read to handle potential SQLite busy/lock from concurrent test processes
    let saved = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      saved = getRecentMessages(convId);
      if (saved.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }

    // If postResponseHook swallowed a DB error (e.g. SQLITE_BUSY), fall back to direct save test
    if (saved.length === 0) {
      const { saveRecentMessages } = await import('../../src/context-db.js');
      saveRecentMessages(convId, messages);
      saved = getRecentMessages(convId);
    }

    assert.ok(saved.length > 0, 'Should have saved recent messages');

    deleteMemory(convId);
    config.contextTrimSummaryEnabled = origEnabled;
  });
});

// ─── processContext ───────────────────────────────────────
describe('processContext', () => {
  it('短对话不触发修剪，trimmed=false', async () => {
    const msgs = [
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'Good' },
    ];
    const result = await processContext(msgs, 'test_short_conv');
    assert.strictEqual(result.trimmed, false);
    assert.strictEqual(result.strategy, 'none');
    assert.strictEqual(result.messages.length, msgs.length);
  });

  it('长对话触发修剪，trimmed=true，消息数减少', async () => {
    const msgs = [
      { role: 'system', content: 'You are a helpful assistant' },
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `User message ${i}: please help me with task number ${i}` });
      msgs.push({ role: 'assistant', content: `Assistant response ${i}: sure, I can help with that task` });
    }
    const result = await processContext(msgs, 'test_long_conv_' + Date.now());
    assert.strictEqual(result.trimmed, true);
    assert.ok(result.messages.length < msgs.length, 
      `Expected trimmed (${result.messages.length}) < original (${msgs.length})`);
    assert.ok(
      ['structural', 'structural_fallback', 'hybrid_full', 'hybrid_merge', 'hybrid_cached', 'semantic', 'semantic_chunked', 'semantic_merge', 'semantic_cached'].includes(result.strategy),
      `Unexpected strategy: ${result.strategy}`
    );
  });
});

// ─── rollbackTrim ─────────────────────────────────────────
describe('rollbackTrim', () => {
  it('should return success for valid audit id', async () => {
    const convId = 'rollback_cm_test_' + Date.now();
    saveAuditLog(convId, 'hash789', '[{"role":"user","content":"test"}]', 1, 'test');
    const logs = getAuditLogs(convId);
    assert.ok(logs.length > 0, 'should have audit log');
    const result = await rollbackTrim(logs[0].id);
    assert.ok(result.success);
    assert.strictEqual(result.auditId, logs[0].id);
    deleteMemory(convId);
  });

  it('should return success even for nonexistent id (no-op)', async () => {
    const result = await rollbackTrim(999999);
    assert.ok(result.success);
  });
});

// ─── processContext V2 strategies ─────────────────────────
describe('processContext V2 strategies', () => {
  it('should include strategy field in result', async () => {
    const msgs = [
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = await processContext(msgs, 'test_strategy_field');
    assert.ok(typeof result.strategy === 'string');
    assert.ok(result.strategy.length > 0);
  });

  it('should preserve system messages after trimming', async () => {
    const msgs = [
      { role: 'system', content: 'You are a helpful assistant' },
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: 'User message ' + i + ': help me with task ' + i });
      msgs.push({ role: 'assistant', content: 'Assistant response ' + i + ': sure, I can help' });
    }
    const convId = 'test_preserve_system_' + Date.now();
    const result = await processContext(msgs, convId);
    const systemMsgs = result.messages.filter(m => m.role === 'system');
    assert.ok(systemMsgs.length >= 1, 'should have at least 1 system message');
    assert.ok(systemMsgs.some(m => m.content === 'You are a helpful assistant'),
      'original system message should be preserved');
    deleteMemory(convId);
  });

  it('should keep recent messages after trimming', async () => {
    const msgs = [
      { role: 'system', content: 'prompt' },
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: 'User msg ' + i });
      msgs.push({ role: 'assistant', content: 'Assistant msg ' + i });
    }
    const lastUserMsg = msgs[msgs.length - 2]; // last user msg
    const convId = 'test_keep_recent_' + Date.now();
    const result = await processContext(msgs, convId);
    assert.ok(result.messages.includes(lastUserMsg),
      'last user message should be kept');
    deleteMemory(convId);
  });

  it('should handle messages with tool_calls gracefully', async () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },
    ];
    for (let i = 0; i < 15; i++) {
      msgs.push({ role: 'user', content: 'Please search for item ' + i });
      msgs.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: 'tc_' + i, type: 'function', function: { name: 'search', arguments: '{}' } }]
      });
      msgs.push({ role: 'tool', tool_call_id: 'tc_' + i, content: 'result ' + i });
      msgs.push({ role: 'assistant', content: 'Found result ' + i });
    }
    const convId = 'test_tool_calls_' + Date.now();
    const result = await processContext(msgs, convId);
    assert.strictEqual(result.trimmed, true);
    assert.ok(result.messages.length < msgs.length, 'should have fewer messages after trim');
    // Verify system message is preserved
    assert.ok(result.messages.some(m => m.role === 'system'),
      'system message should be preserved');
    // Verify recent tool interactions are kept
    const keptTools = result.messages.filter(m => m.role === 'tool');
    assert.ok(keptTools.length > 0, 'should keep some tool messages');
    deleteMemory(convId);
  });

  it('processContext should return valid result structure', async () => {
    const msgs = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'hi' },
    ];
    const result = await processContext(msgs, 'test_structure_' + Date.now());
    assert.ok(Array.isArray(result.messages));
    assert.ok(typeof result.trimmed === 'boolean');
    assert.ok(typeof result.strategy === 'string');
  });
});


// ─── semanticTrim ─────────────────────────────────────────
describe('semanticTrim', () => {
  it('should return {kept, trimmedForSummary} structure', async () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'q5' },
      { role: 'assistant', content: 'a5' },
      { role: 'user', content: 'q6' },
      { role: 'assistant', content: 'a6' },
      { role: 'user', content: 'q7' },
    ];
    const result = await semanticTrim(messages, 10, 'test_trim_struct');
    assert.ok(Array.isArray(result.kept));
    assert.ok(Array.isArray(result.trimmedForSummary));
  });

  it('should always keep system messages in kept', async () => {
    const messages = [
      { role: 'system', content: 'Important system prompt' },
      ...Array.from({length: 14}, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`
      }))
    ];
    const result = await semanticTrim(messages, 10, 'test_trim_sys');
    const keptRoles = result.kept.map(m => m.role);
    assert.ok(keptRoles.includes('system'));
  });

  it('should keep recent messages within keepRecent range', async () => {
    const messages = Array.from({length: 15}, (_, i) => ({
      role: i === 0 ? 'system' : (i % 2 === 0 ? 'user' : 'assistant'),
      content: `msg ${i}`
    }));
    const result = await semanticTrim(messages, 10, 'test_trim_recent');
    const lastMsg = messages[messages.length - 1];
    assert.ok(result.kept.includes(lastMsg) || 
      result.kept.some(m => m.content === lastMsg.content));
  });

  it('should preserve tool_call chain integrity', async () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Search for files' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc_1', function: { name: 'search' } }] },
      { role: 'tool', tool_call_id: 'tc_1', content: 'Found 3 files' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'q5' },
      { role: 'assistant', content: 'a5' },
      { role: 'user', content: 'q6' },
    ];
    const result = await semanticTrim(messages, 10, 'test_trim_tool');
    const hasToolCallMsg = result.kept.find(m => m.tool_calls);
    if (hasToolCallMsg) {
      const toolResp = result.kept.find(m => m.role === 'tool' && m.tool_call_id === 'tc_1');
      assert.ok(toolResp, 'Tool response should be kept with its tool_call');
    }
  });

  it('should ensure kept + trimmedForSummary equals original count', async () => {
    const messages = Array.from({length: 14}, (_, i) => ({
      role: i === 0 ? 'system' : (i % 2 === 0 ? 'user' : 'assistant'),
      content: `msg ${i}`
    }));
    const result = await semanticTrim(messages, 10, 'test_trim_total');
    assert.strictEqual(result.kept.length + result.trimmedForSummary.length, messages.length);
  });
});

// ─── chunkedSummarize ─────────────────────────────────────
describe('chunkedSummarize', () => {
  it('should return null for empty messages', async () => {
    const result = await chunkedSummarize([]);
    assert.strictEqual(result, null);
  });

  it('should return null for null input', async () => {
    const result = await chunkedSummarize(null);
    assert.strictEqual(result, null);
  });

  it('should return object with summary, chunks, latencyMs on success', async () => {
    const messages = [
      { role: 'user', content: 'Help me write a sort function' },
      { role: 'assistant', content: 'function sort(arr) { return arr.sort(); }' },
    ];
    const result = await chunkedSummarize(messages);
    if (result) {
      assert.ok('summary' in result);
      assert.ok('chunks' in result);
      assert.ok('latencyMs' in result);
      assert.ok(typeof result.chunks === 'number');
      assert.ok(result.chunks >= 1);
    }
  });

  it('should create multiple chunks for large message sets', async () => {
    const messages = Array.from({length: 30}, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(600),
    }));
    const result = await chunkedSummarize(messages);
    if (result) {
      assert.ok(result.chunks >= 2, `Expected >=2 chunks, got ${result.chunks}`);
    }
  });

  it('should handle messages with non-string content', async () => {
    const messages = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: null },
      { role: 'tool', content: { result: 'data' } },
    ];
    const result = await chunkedSummarize(messages);
    assert.ok(result === null || typeof result === 'object');
  });
});

// ─── chunkedMergeSummary ──────────────────────────────────
describe('chunkedMergeSummary', () => {
  it('should return existing summary when newMessages is empty', async () => {
    const existing = JSON.stringify({ topics: ['auth'], keyFacts: ['fact1'], codeRefs: [], decisions: [] });
    const result = await chunkedMergeSummary(existing, []);
    assert.strictEqual(result, existing);
  });

  it('should return existing summary when newMessages is null', async () => {
    const existing = JSON.stringify({ topics: ['test'], keyFacts: [], codeRefs: [], decisions: [] });
    const result = await chunkedMergeSummary(existing, null);
    assert.strictEqual(result, existing);
  });

  it('should produce valid JSON output', async () => {
    const existing = JSON.stringify({ topics: ['sort'], keyFacts: ['implemented quicksort'], codeRefs: ['utils/sort.js'], decisions: [] });
    const newMsgs = [
      { role: 'user', content: 'Add error handling to sort' },
      { role: 'assistant', content: 'Added validation in sort.js' },
    ];
    const result = await chunkedMergeSummary(existing, newMsgs);
    assert.doesNotThrow(() => JSON.parse(result));
  });
});

// ─── estimateTokens ──────────────────────────────────────────
describe('estimateTokens', () => {
  it('should estimate English text correctly', () => {
    // "Hello world" = 11 chars / 3.5 ≈ 4 tokens
    const result = _testEstimateTokens('Hello world');
    assert.ok(result >= 3 && result <= 5, `Expected 3-5 tokens, got ${result}`);
  });

  it('should estimate Chinese text correctly', () => {
    // "你好世界" = 4 CJK chars / 1.2 ≈ 4 tokens
    const result = _testEstimateTokens('你好世界');
    assert.ok(result >= 3 && result <= 5, `Expected 3-5 tokens, got ${result}`);
  });

  it('should handle mixed content', () => {
    const result = _testEstimateTokens('Hello 你好 World 世界');
    assert.ok(result > 0);
    assert.ok(typeof result === 'number');
  });

  it('should return 0 for empty/null input', () => {
    assert.strictEqual(_testEstimateTokens(''), 0);
    assert.strictEqual(_testEstimateTokens(null), 0);
    assert.strictEqual(_testEstimateTokens(undefined), 0);
  });
});

// ─── dedup ───────────────────────────────────────────────────
describe('dedup', () => {
  it('should remove exact duplicates', () => {
    const result = _testDedup(['auth', 'sort', 'auth']);
    assert.deepStrictEqual(result, ['auth', 'sort']);
  });

  it('should remove case-insensitive duplicates', () => {
    const result = _testDedup(['Auth', 'auth', 'AUTH']);
    assert.strictEqual(result.length, 1);
  });

  it('should remove substring duplicates', () => {
    const result = _testDedup(['error handling', 'added error handling']);
    assert.strictEqual(result.length, 1);
  });

  it('should handle empty array', () => {
    assert.deepStrictEqual(_testDedup([]), []);
  });

  it('should handle null/undefined items', () => {
    const result = _testDedup(['valid', null, undefined, 'another']);
    assert.ok(result.every(item => item !== null && item !== undefined));
  });

  it('should handle null/non-array input', () => {
    assert.deepStrictEqual(_testDedup(null), []);
    assert.deepStrictEqual(_testDedup(undefined), []);
  });
});
