# 智能上下文管理系统 - 发现的问题清单

## 发现概览

**检查日期**: 2026-04-22  
**检查状态**: ✅ 完成  
**严重问题**: 0  
**警告问题**: 2  
**提示问题**: 1

---

## 🔴 严重问题 (Critical) - 0 项

无。

---

## 🟠 警告问题 (Warning) - 2 项

### 问题 #1: 摘要生成缺少超时控制

**位置**: `/home/ctyun/WindsurfPoolAPI-fork/src/context-manager.js:143-159`

**函数**: `callLightweightModel(prompt)`

**问题描述**:
- ❌ 没有显式的超时控制 (timeout/AbortController)
- 如果上游模型服务 hang 住，会导致 postResponseHook 阻塞
- setImmediate() 虽然不阻塞主线程，但资源占用会累积

**当前代码**:
```javascript
async function callLightweightModel(prompt) {
  try {
    const handler = await getHandleChatCompletions();
    const result = await handler({
      model: config.contextTrimSummaryModel || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 800,
      temperature: 0.2,
      _internal: true,
    });
    return result?.body?.choices?.[0]?.message?.content || null;
  } catch (err) {
    log.warn('Lightweight model call failed:', err.message);
    return null;
  }
}
```

**修复方案**:
```javascript
async function callLightweightModel(prompt, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handler = await getHandleChatCompletions();
    const result = await handler({
      model: config.contextTrimSummaryModel || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 800,
      temperature: 0.2,
      _internal: true,
      signal: controller.signal,  // 添加中止信号
    });
    clearTimeout(timeout);
    return result?.body?.choices?.[0]?.message?.content || null;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      log.warn(`Summary generation timeout after ${timeoutMs}ms, conversation=${conversationId}`);
    } else {
      log.warn('Lightweight model call failed:', err.message);
    }
    return null;
  }
}
```

**风险等级**: 🟠 中

**优先级**: 🔴 必做

**预计工作量**: 30 分钟

**测试建议**:
```javascript
it('callLightweightModel should timeout if model hangs', async () => {
  // Mock a handler that never resolves
  // Verify that timeout is called
  // Verify that AbortError is caught
});
```

---

### 问题 #2: LLM 返回的摘要缺少 JSON 格式验证

**位置**: `/home/ctyun/WindsurfPoolAPI-fork/src/context-manager.js:161-181, 183-204`

**函数**: `generateFullSummary(messages)`, `mergeSummary(existingSummaryJson, newMessages)`

**问题描述**:
- ❌ LLM 可能返回非 JSON 文本 (格式错误、部分内容等)
- 直接字符串化可能导致格式混乱
- 在 processContext() 和 postResponseHook() 中都会调用，风险累积

**当前代码**:
```javascript
async function generateFullSummary(messages) {
  if (!config.contextTrimSummaryEnabled || messages.length === 0) return null;
  
  const prompt = `...`;
  return await callLightweightModel(prompt);  // ❌ 无验证
}

async function mergeSummary(existingSummaryJson, newMessages) {
  if (!config.contextTrimSummaryEnabled || newMessages.length === 0) return existingSummaryJson;
  
  const prompt = `...`;
  return await callLightweightModel(prompt);  // ❌ 无验证
}

// 使用点 (line 257-258)
...(summaryText ? [{
  role: 'system',
  content: `[Conversation Memory]\n${summaryText}`  // ⚠️ 直接使用
}] : []),
```

**修复方案**:
```javascript
async function generateFullSummary(messages) {
  if (!config.contextTrimSummaryEnabled || messages.length === 0) return null;
  
  const prompt = `...`;
  const raw = await callLightweightModel(prompt);
  
  if (!raw) return null;
  
  try {
    // 验证返回的文本是否是有效 JSON
    const parsed = JSON.parse(raw);
    
    // 检查必要字段
    if (!parsed.goals || !Array.isArray(parsed.goals)) {
      throw new Error('Missing required "goals" field');
    }
    
    return JSON.stringify(parsed);  // 验证后返回
  } catch (e) {
    log.warn('Summary JSON parse failed:', e.message, 'raw text:', raw.substring(0, 100));
    
    // 返回默认结构
    return JSON.stringify({
      goals: ["摘要生成失败，使用默认结构"],
      decisions: [],
      codeChanges: [],
      constraints: [],
      openIssues: []
    });
  }
}

async function mergeSummary(existingSummaryJson, newMessages) {
  if (!config.contextTrimSummaryEnabled || newMessages.length === 0) {
    return existingSummaryJson;  // 返回现有摘要
  }
  
  const prompt = `...`;
  const raw = await callLightweightModel(prompt);
  
  if (!raw) return existingSummaryJson;  // 保持现有摘要
  
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.goals || !Array.isArray(parsed.goals)) {
      throw new Error('Missing required "goals" field');
    }
    return JSON.stringify(parsed);
  } catch (e) {
    log.warn('Merge summary JSON parse failed:', e.message);
    return existingSummaryJson;  // 保持现有摘要
  }
}
```

**风险等级**: 🟠 中

**优先级**: 🔴 必做

**预计工作量**: 30 分钟

**测试建议**:
```javascript
it('generateFullSummary should validate JSON structure', async () => {
  // Mock callLightweightModel to return invalid JSON
  // Verify that default structure is returned
});

it('mergeSummary should fallback to existing if parse fails', async () => {
  // Mock callLightweightModel to return malformed JSON
  // Verify that existing summary is preserved
});
```

---

## 🟡 提示问题 (Info) - 1 项

### 问题 #3: 服务关闭缺少 Graceful Shutdown

**位置**: 需要在服务启动文件中添加 (预期: `src/index.js` 或 `src/server.js`)

**问题描述**:
- closeDb() 被调用时，可能仍有 postResponseHook 在执行
- better-sqlite3 虽然会等待同步操作，但应该有明确的关闭流程
- 当前没有看到 process.on('SIGTERM') 或 process.on('SIGINT') 的处理

**建议修复**:
```javascript
// 在 server 启动文件中，接近末尾处添加

let isShuttingDown = false;

process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  log.info('Received SIGTERM, shutting down gracefully...');
  
  // 停止接收新请求 (可选，根据框架能力)
  // server.close();  
  
  // 等待现有请求和后台任务完成 (最多 5 秒)
  await new Promise(r => setTimeout(r, 5000));
  
  // 关闭数据库连接
  closeDb();
  
  log.info('Database closed, exiting');
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  log.info('Received SIGINT (Ctrl+C), shutting down gracefully...');
  
  await new Promise(r => setTimeout(r, 5000));
  closeDb();
  
  log.info('Database closed, exiting');
  process.exit(0);
});
```

**风险等级**: 🟡 低

**优先级**: 🟡 可选

**预计工作量**: 30 分钟

---

## 测试覆盖度评估

### 新增模块的测试覆盖度

| 模块 | 覆盖度 | 建议 |
|------|--------|------|
| context-db.js | 0% | 需要单元测试 |
| context-manager.js | 0% | 需要单元测试 + 集成测试 |
| Dashboard API (context-memory/*) | 0% | 需要 API 集成测试 |

### 建议创建的测试文件

1. **test/unit/context-db.test.js** (优先级: 🔴 高)
   - getMemory() / upsertMemory() CRUD 测试
   - 事务处理验证
   - 过期数据清理测试
   - 关闭流程测试

2. **test/unit/context-manager.test.js** (优先级: 🔴 高)
   - deriveConversationId() 边界测试
   - scoreMessage() 评分逻辑测试
   - structuralTrim() 裁剪算法测试
   - extractWorkingMemory() 提取逻辑测试
   - processContext() 整体流程测试

3. **test/integration/chat-internal-bypass.test.js** (优先级: 🟠 中)
   - _internal=true 时跳过缓存
   - _internal=true 时跳过会话复用
   - _internal=true 时跳过上下文修剪

4. **test/integration/dashboard-context-api.test.js** (优先级: 🟠 中)
   - GET /context-memory/stats
   - GET /context-memory/conversations
   - DELETE /context-memory/:id
   - GET /settings/context-trim
   - PUT /settings/context-trim

---

## 实施清单

- [ ] 修复问题 #1: 添加超时控制 (30 分钟)
- [ ] 修复问题 #2: 添加 JSON 验证 (30 分钟)
- [ ] 修复问题 #3: 添加 Graceful Shutdown (30 分钟, 可选)
- [ ] 创建 context-db.test.js (1-2 小时)
- [ ] 创建 context-manager.test.js (1-2 小时)
- [ ] 创建 chat-internal-bypass.test.js (1 小时)
- [ ] 创建 dashboard-context-api.test.js (1 小时)
- [ ] 运行全部测试验证
- [ ] 更新 CHANGELOG

---

## 检查结果汇总

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 代码完整性 | ✅ PASS | 所有模块导出正确 |
| Config 一致性 | ✅ PASS | 所有属性引用正确 |
| API 路由注册 | ✅ PASS | 5 个端点已实现 |
| _internal 守卫 | ✅ PASS | 7 个守卫点完整 |
| TDZ 修复 | ✅ PASS | 变量声明顺序正确 |
| Hook 集成 | ✅ PASS | postResponseHook 正确集成 |
| UI 完整性 | ✅ PASS | 导航、面板、函数完整 |
| 循环依赖 | ✅ SAFE | 动态 import 妥善避免 |
| SQLite 并发 | ✅ SAFE | WAL + 超时配置得当 |
| 空数组处理 | ✅ PASS | 边界条件正确处理 |
| 摘要超时 | ⚠️ WARNING | 缺少超时控制 |
| JSON 验证 | ⚠️ WARNING | 缺少格式验证 |
| 测试覆盖 | ❌ FAIL | 新模块无测试 |
| 服务运行 | ✅ OK | 正常运行 |
| API 响应 | ✅ OK | 端点返回正确 |

---

**报告生成时间**: 2026-04-22 13:30 UTC  
**报告版本**: 1.0  
**相关文档**: CONTEXT_SYSTEM_QA_REPORT.md
