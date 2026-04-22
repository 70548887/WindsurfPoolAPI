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
});
