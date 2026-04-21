// test/helpers/mock.js
// 轻量级测试 mock 工具 - 零外部依赖

/**
 * 生成测试用账号对象
 * @param {Object} overrides - 覆盖默认值的属性
 * @returns {Object} 模拟账号对象
 */
export function createMockAccount(overrides = {}) {
  return {
    id: 'test-account-001',
    token: 'devin-session-token$test-token-value',
    apiKey: 'test-api-key',
    tier: 'free',
    pro: false,
    status: 'active',
    blockedModels: [],
    capabilities: {},
    tierManual: false,
    errors: 0,
    rpm: { current: 0, max: 10 },
    lastUsed: null,
    ...overrides,
  };
}

/**
 * 生成测试用 OpenAI 格式请求
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息列表
 * @param {Object} options - 额外选项
 * @returns {Object} 模拟请求对象
 */
export function createMockRequest(model, messages, options = {}) {
  return {
    model: model || 'gpt-4o-mini',
    messages: messages || [{ role: 'user', content: 'test' }],
    max_tokens: 100,
    stream: false,
    ...options,
  };
}

/**
 * 模拟 LS 进程对象
 * @returns {Object} 具有 on/emit/kill 方法的模拟进程
 */
export function createMockLsProcess() {
  const proc = {
    pid: 99999,
    port: 42100,
    killed: false,
    exitCode: null,
    listeners: {},
    on(event, cb) {
      if (!proc.listeners[event]) {
        proc.listeners[event] = [];
      }
      proc.listeners[event].push(cb);
      return proc;
    },
    emit(event, ...args) {
      const cbs = proc.listeners[event] || [];
      for (const cb of cbs) {
        cb(...args);
      }
      return cbs.length > 0;
    },
    kill(signal) {
      proc.killed = true;
      proc.exitCode = signal === 'SIGKILL' ? 137 : 143;
      proc.emit('exit', proc.exitCode, signal);
      return true;
    },
  };
  return proc;
}

/**
 * 已弃用的模型 UID 列表 - 用于回归测试验证
 */
export const DEPRECATED_MODEL_UIDS = [
  'MODEL_CLAUDE_4_SONNET',
  'MODEL_CLAUDE_4_SONNET_THINKING',
  'MODEL_CLAUDE_4_OPUS',
  'MODEL_CLAUDE_4_OPUS_THINKING',
  'MODEL_CLAUDE_4_1_OPUS',
  'MODEL_CLAUDE_4_1_OPUS_THINKING',
];
