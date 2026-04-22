import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertMemory,
  getMemory,
  saveRecentMessages,
  getRecentMessages,
  recordTrimStats,
  getTrimStats,
  getRecentTrimEvents,
  deleteMemory,
  getActiveConversations,
  getContextMemoryOverview,
  saveEmbeddings,
  getEmbeddings,
  cleanEmbeddings,
  saveAuditLog,
  getAuditLogs,
  getRecentAuditLogs,
  markRolledBack,
  closeDb,
} from '../../src/context-db.js';

const testIds = [];

function uniqueId(prefix = 'test') {
  const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  testIds.push(id);
  return id;
}

afterEach(() => {
  for (const id of testIds) {
    try { deleteMemory(id); } catch {}
  }
  testIds.length = 0;
});

after(() => {
  closeDb();
});

describe('upsertMemory + getMemory', () => {
  it('写入后能读取到', () => {
    const id = uniqueId('upsert');
    upsertMemory(id, '{"goals":["test"]}', 5, 'gpt-4o-mini');
    const row = getMemory(id);
    assert.ok(row, 'should return a row');
    assert.strictEqual(row.conversation_id, id);
    assert.strictEqual(row.summary, '{"goals":["test"]}');
    assert.strictEqual(row.covered_turns, 5);
    assert.strictEqual(row.model, 'gpt-4o-mini');
  });
});

describe('upsertMemory 重复写入', () => {
  it('summary_version 自增', () => {
    const id = uniqueId('dup');
    upsertMemory(id, 'v1', 1, 'model-a');
    const first = getMemory(id);
    assert.strictEqual(first.summary_version, 0);

    upsertMemory(id, 'v2', 2, 'model-a');
    const second = getMemory(id);
    assert.strictEqual(second.summary_version, 1);
    assert.strictEqual(second.summary, 'v2');

    upsertMemory(id, 'v3', 3, 'model-a');
    const third = getMemory(id);
    assert.strictEqual(third.summary_version, 2);
  });
});

describe('getMemory 不存在的 ID', () => {
  it('返回 null', () => {
    const result = getMemory('non_existent_id_xyz_999');
    assert.strictEqual(result, null);
  });
});

describe('saveRecentMessages + getRecentMessages', () => {
  it('事务写入后读取正确', () => {
    const id = uniqueId('msgs');
    upsertMemory(id, 'summary', 0, 'model');
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' },
    ];
    saveRecentMessages(id, messages);
    const rows = getRecentMessages(id);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].role, 'user');
    assert.strictEqual(rows[0].content, 'Hello');
    assert.strictEqual(rows[1].role, 'assistant');
    assert.strictEqual(rows[2].turn_index, 2);
  });
});

describe('recordTrimStats + getTrimStats', () => {
  it('统计写入后聚合正确', () => {
    const id = uniqueId('stats');
    recordTrimStats(id, 20, 10, 'structural', 150);
    recordTrimStats(id, 30, 15, 'structural', 250);
    recordTrimStats(id, 25, 12, 'hybrid_full', 300);

    const stats = getTrimStats();
    assert.ok(Array.isArray(stats));
    const structural = stats.find(s => s.strategy_used === 'structural');
    assert.ok(structural, 'should have structural strategy stats');
    assert.ok(structural.count >= 2, 'should have at least 2 structural entries');
  });
});

describe('getRecentTrimEvents', () => {
  it('返回最近事件列表', () => {
    const id = uniqueId('events');
    recordTrimStats(id, 20, 10, 'test_strategy', 100);
    const events = getRecentTrimEvents();
    assert.ok(Array.isArray(events));
    assert.ok(events.length > 0, 'should have at least one event');
    const latest = events[0];
    assert.ok(latest.created_at, 'should have created_at');
  });
});

describe('deleteMemory', () => {
  it('同时删除关联的 recent_messages', () => {
    const id = uniqueId('del');
    upsertMemory(id, 'to-delete', 1, 'model');
    saveRecentMessages(id, [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ]);
    assert.ok(getMemory(id), 'memory should exist before delete');
    assert.strictEqual(getRecentMessages(id).length, 2);

    deleteMemory(id);
    assert.strictEqual(getMemory(id), null, 'memory should be null after delete');
    assert.strictEqual(getRecentMessages(id).length, 0, 'messages should be empty after delete');
    const idx = testIds.indexOf(id);
    if (idx >= 0) testIds.splice(idx, 1);
  });
});

describe('getActiveConversations', () => {
  it('只返回未过期会话', () => {
    const activeId = uniqueId('active');
    upsertMemory(activeId, 'active-summary', 1, 'model');

    const conversations = getActiveConversations();
    assert.ok(Array.isArray(conversations));
    const found = conversations.find(c => c.conversation_id === activeId);
    assert.ok(found, 'should find the active conversation');
  });
});

describe('getContextMemoryOverview', () => {
  it('概览数据正确', () => {
    const id = uniqueId('overview');
    upsertMemory(id, 'overview-summary', 3, 'model');
    recordTrimStats(id, 20, 10, 'overview_test', 100);

    const overview = getContextMemoryOverview();
    assert.ok(typeof overview.activeConversations === 'number');
    assert.ok(overview.activeConversations >= 1, 'should have at least 1 active conversation');
    assert.ok(typeof overview.totalTrimCount === 'number');
    assert.ok(overview.totalTrimCount >= 1, 'should have at least 1 trim count');
    assert.ok(Array.isArray(overview.byStrategy));
  });
});


// ─── saveEmbeddings + getEmbeddings ─────────────────────────
describe('saveEmbeddings and getEmbeddings', () => {
  it('should save and retrieve embeddings', () => {
    const id = uniqueId('embed');
    upsertMemory(id, 'dummy', 0, 'model');
    const entries = [
      { contentHash: 'hash_embed_1', role: 'user', embedding: new Float32Array([1.0, 2.0, 3.0]) },
      { contentHash: 'hash_embed_2', role: 'assistant', embedding: new Float32Array([4.0, 5.0, 6.0]) },
    ];
    saveEmbeddings(id, entries);

    const result = getEmbeddings(id);
    assert.strictEqual(result.size, 2);
    assert.ok(result.has('hash_embed_1'));

    const vec = result.get('hash_embed_1');
    assert.ok(vec instanceof Float32Array);
    assert.strictEqual(vec.length, 3);
    assert.ok(Math.abs(vec[0] - 1.0) < 0.001);
  });

  it('should handle UPSERT on duplicate contentHash', () => {
    const id = uniqueId('embed_dup');
    upsertMemory(id, 'dummy', 0, 'model');
    const entries1 = [{ contentHash: 'hash_dup', role: 'user', embedding: new Float32Array([1.0, 2.0]) }];
    const entries2 = [{ contentHash: 'hash_dup', role: 'user', embedding: new Float32Array([3.0, 4.0]) }];
    saveEmbeddings(id, entries1);
    saveEmbeddings(id, entries2);

    const result = getEmbeddings(id);
    assert.strictEqual(result.size, 1);
    const vec = result.get('hash_dup');
    assert.ok(Math.abs(vec[0] - 3.0) < 0.001);
  });

  it('should clean embeddings for conversation', () => {
    const id = uniqueId('embed_clean');
    upsertMemory(id, 'dummy', 0, 'model');
    saveEmbeddings(id, [{ contentHash: 'h1', role: 'user', embedding: new Float32Array([1]) }]);
    cleanEmbeddings(id);
    const result = getEmbeddings(id);
    assert.strictEqual(result.size, 0);
  });

  it('should return empty map for unknown conversation', () => {
    const result = getEmbeddings('nonexistent_embed_conv_xyz');
    assert.strictEqual(result.size, 0);
  });
});

// ─── saveAuditLog + getAuditLogs ─────────────────────────
describe('saveAuditLog and getAuditLogs', () => {
  it('should save and retrieve audit logs', () => {
    const id = uniqueId('audit');
    upsertMemory(id, 'dummy', 0, 'model');
    saveAuditLog(id, 'hash123', '{"data":"test"}', 5, 'semantic_chunked');
    const logs = getAuditLogs(id);
    assert.ok(logs.length > 0);
    assert.strictEqual(logs[0].conversation_id, id);
    assert.strictEqual(logs[0].trimmed_count, 5);
    assert.strictEqual(logs[0].strategy, 'semantic_chunked');
    assert.strictEqual(logs[0].rolled_back, 0);
  });

  it('should get recent audit logs', () => {
    const logs = getRecentAuditLogs(5);
    assert.ok(Array.isArray(logs));
  });

  it('should mark audit as rolled back', () => {
    const id = uniqueId('audit_rb');
    upsertMemory(id, 'dummy', 0, 'model');
    saveAuditLog(id, 'hash456', '{}', 3, 'test');
    const logs = getAuditLogs(id);
    const auditId = logs[0].id;
    markRolledBack(auditId);
    const updated = getAuditLogs(id);
    assert.strictEqual(updated[0].rolled_back, 1);
  });

  it('should return empty array for unknown conversation', () => {
    const logs = getAuditLogs('nonexistent_audit_conv_xyz');
    assert.ok(Array.isArray(logs));
    assert.strictEqual(logs.length, 0);
  });
});

// ─── closeDb 放在最后测试 ─────────────────────────────────
describe('closeDb', () => {
  it('closeDb should close without error', () => {
    assert.doesNotThrow(() => closeDb());
  });
});
