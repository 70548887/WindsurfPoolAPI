/**
 * API 端点集成测试
 *
 * 前置条件：WindsurfPoolAPI 服务需在 localhost:3003 运行
 * 运行方式：npm run test:integration
 *
 * 注意：这些测试会发起真实 HTTP 请求到运行中的服务
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3003';
const REQUEST_TIMEOUT = 30_000; // 30s，AI 模型响应可能较慢

/**
 * 带超时的 fetch 封装
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检测服务是否可达
 */
async function isServiceRunning() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

describe('WindsurfPoolAPI 集成测试', { timeout: REQUEST_TIMEOUT + 5000 }, () => {
  let serviceAvailable = false;

  before(async () => {
    serviceAvailable = await isServiceRunning();
    if (!serviceAvailable) {
      console.log('\n⚠️  WindsurfPoolAPI 服务未在 localhost:3003 运行，跳过所有集成测试。');
      console.log('   请先启动服务：npm start\n');
    }
  });

  describe('GET /health', () => {
    it('健康检查应返回 200', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/health`);
      assert.equal(res.status, 200);
    });
  });

  describe('GET /v1/models', () => {
    it('应返回 200 及包含模型的 data 数组', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/v1/models`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(Array.isArray(body.data), '响应应包含 data 数组');
      assert.ok(body.data.length > 0, 'data 数组长度应 > 0');

      for (const model of body.data) {
        assert.ok(model.id, '每个模型对象应有 id 字段');
      }
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('免费模型应成功返回聊天结果', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Say hi' }],
          max_tokens: 10,
          stream: false,
        }),
      });

      assert.equal(res.status, 200);

      const body = await res.json();
      assert.ok(Array.isArray(body.choices), '响应应包含 choices 数组');
      assert.ok(body.choices.length > 0, 'choices 数组不应为空');

      const content = body.choices[0]?.message?.content;
      assert.ok(typeof content === 'string' && content.length > 0, 'choices[0].message.content 应为非空字符串');
    });

    it('无效模型应返回错误', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nonexistent-model-xyz',
          messages: [{ role: 'user', content: 'test' }],
          stream: false,
        }),
      });

      assert.notEqual(res.status, 200, 'HTTP 状态码应非 200');

      const body = await res.json();
      assert.ok(body.error, '响应应包含 error 字段');
    });

    it('空消息数组应返回错误', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [],
          stream: false,
        }),
      });

      assert.notEqual(res.status, 200, 'HTTP 状态码应非 200');

      const body = await res.json();
      assert.ok(body.error, '响应应包含 error 字段');
    });
  });

  describe('CORS headers', () => {
    it('OPTIONS 预检请求应返回 CORS 相关 header', async (t) => {
      if (!serviceAvailable) return t.skip('服务未运行');

      const res = await fetchWithTimeout(`${BASE_URL}/v1/models`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });

      // 检查常见 CORS header（至少有一个存在）
      const corsHeaders = [
        'access-control-allow-origin',
        'access-control-allow-methods',
        'access-control-allow-headers',
      ];

      const found = corsHeaders.some((h) => res.headers.has(h));
      assert.ok(found, `响应应包含至少一个 CORS header (${corsHeaders.join(', ')})`);
    });
  });
});
