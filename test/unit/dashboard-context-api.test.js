/**
 * Dashboard Context Memory API 端点集成测试
 * 直接调用 handleDashboardApi 函数，模拟 HTTP req/res 对象
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleDashboardApi } from '../../src/dashboard/api.js';
import {
  upsertMemory,
  recordTrimStats,
  deleteMemory,
  closeDb,
  saveAuditLog,
  getAuditLogs,
} from '../../src/context-db.js';
import { config } from '../../src/config.js';

// 模拟 HTTP response 对象
function mockRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    writeHead(status, headers) {
      res._status = status;
      Object.assign(res._headers, headers || {});
    },
    end(data) {
      if (data) res._body = JSON.parse(data);
    },
  };
  return res;
}

// 模拟 HTTP request 对象（带认证头通过 checkAuth）
function mockReq(url) {
  return {
    headers: { 'x-dashboard-password': config.dashboardPassword || config.apiKey || '' },
    url: url || '/dashboard/api/context-memory/stats',
  };
}

const testConvId = 'dashboard_api_test_conv1';

before(() => {
  upsertMemory(testConvId, '{"goals":["test dashboard api"]}', 3, 'gpt-4o-mini');
  recordTrimStats(testConvId, 20, 10, 'hybrid_test', 1500);
});

after(() => {
  deleteMemory(testConvId);
  closeDb();
});

describe('Dashboard Context Memory API', () => {
  // GET /context-memory/stats
  it('GET /context-memory/stats should return overview with activeConversations', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/stats');
    await handleDashboardApi('GET', '/context-memory/stats', {}, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(typeof res._body.activeConversations === 'number');
    assert.ok(res._body.activeConversations >= 1);
    assert.ok(typeof res._body.totalTrimCount === 'number');
    assert.ok(Array.isArray(res._body.recentEvents));
  });

  // GET /context-memory/conversations
  it('GET /context-memory/conversations should return conversation list', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/conversations');
    await handleDashboardApi('GET', '/context-memory/conversations', {}, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(Array.isArray(res._body.conversations));
    const found = res._body.conversations.find(c => c.conversation_id === testConvId);
    assert.ok(found, 'should find our test conversation');
  });

  // DELETE /context-memory/:conversationId
  it('DELETE /context-memory/:id should delete conversation memory', async () => {
    // 先创建一条临时记忆用于删除
    const tempId = 'dashboard_api_del_test';
    upsertMemory(tempId, '{"goals":["to-delete"]}', 1, 'model');

    const res = mockRes();
    const req = mockReq(`/dashboard/api/context-memory/${tempId}`);
    await handleDashboardApi('DELETE', `/context-memory/${tempId}`, {}, req, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.ok, true);
  });

  // GET /settings/context-trim
  it('GET /settings/context-trim should return config', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/settings/context-trim');
    await handleDashboardApi('GET', '/settings/context-trim', {}, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok('contextTrimEnabled' in res._body);
    assert.ok('contextTrimThreshold' in res._body);
    assert.ok('contextTrimKeepRecent' in res._body);
    assert.ok('contextTrimSummaryEnabled' in res._body);
    assert.ok('contextTrimSummaryModel' in res._body);
    assert.ok('contextMemoryTtlHours' in res._body);
  });

  // OPTIONS should return 204
  it('OPTIONS request should return 204', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/stats');
    await handleDashboardApi('OPTIONS', '/context-memory/stats', {}, req, res);
    assert.strictEqual(res._status, 204);
  });

  // ─── V2 新增端点测试 ───────────────────────────────────

  // GET /context-memory/audit-logs
  it('GET /context-memory/audit-logs should return audit logs array', async () => {
    // 先插入一条审计记录
    saveAuditLog('dash_audit_test', 'hash_test', '[]', 3, 'semantic_chunked');

    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/audit-logs');
    await handleDashboardApi('GET', '/context-memory/audit-logs', null, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(res._body.auditLogs);
    assert.ok(Array.isArray(res._body.auditLogs));
    assert.ok(res._body.auditLogs.length >= 1, 'should have at least the inserted audit log');
  });

  // POST /context-memory/rollback/:auditId - 成功
  it('POST /context-memory/rollback/:auditId should rollback successfully', async () => {
    saveAuditLog('dash_rollback_test', 'hash_rb', '[]', 2, 'test');
    const logs = getAuditLogs('dash_rollback_test');
    const auditId = logs[0].id;

    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/rollback/' + auditId);
    await handleDashboardApi('POST', '/context-memory/rollback/' + auditId, null, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(res._body.success);
  });

  // POST /context-memory/rollback/invalid - 错误处理
  it('POST /context-memory/rollback/invalid should handle invalid rollback id', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/rollback/invalid');
    await handleDashboardApi('POST', '/context-memory/rollback/invalid', null, req, res);
    // parseInt('invalid') => NaN => returns 400 { error: 'Invalid audit ID' }
    assert.strictEqual(res._status, 400);
    assert.ok(res._body.error);
  });

  // GET /context-memory/embedding-status
  it('GET /context-memory/embedding-status should return embedding model status', async () => {
    const res = mockRes();
    const req = mockReq('/dashboard/api/context-memory/embedding-status');
    await handleDashboardApi('GET', '/context-memory/embedding-status', null, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(res._body.status);
    assert.ok(['ready', 'loading', 'failed', 'idle'].includes(res._body.status));
  });

  // PUT /settings/context-trim V2 config fields
  it('PUT /settings/context-trim should accept V2 config fields', async () => {
    const body = {
      semanticEnabled: true,
      chunkSize: 2000,
      auditEnabled: true,
    };
    const res = mockRes();
    const req = mockReq('/dashboard/api/settings/context-trim');
    await handleDashboardApi('PUT', '/settings/context-trim', body, req, res);
    assert.strictEqual(res._status, 200);
    assert.ok(res._body.success || res._body.config);

    // 验证配置已更新
    const res2 = mockRes();
    const req2 = mockReq('/dashboard/api/settings/context-trim');
    await handleDashboardApi('GET', '/settings/context-trim', null, req2, res2);
    assert.strictEqual(res2._status, 200);
    assert.strictEqual(res2._body.contextTrimChunkSize, 2000);
  });
});
