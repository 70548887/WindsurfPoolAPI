import { createHash } from 'crypto';
import { config, log } from './config.js';
import { getMemory, upsertMemory, saveRecentMessages, recordTrimStats as dbRecordTrimStats } from './context-db.js';

// ── 动态导入 handleChatCompletions 避免循环依赖 ──
let _handleChat = null;
async function getHandleChatCompletions() {
  if (!_handleChat) {
    const mod = await import('./handlers/chat.js');
    _handleChat = mod.handleChatCompletions;
  }
  return _handleChat;
}

// ── 会话识别 ──
export function deriveConversationId(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'unknown';
  const anchor = messages.slice(0, 3).map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content.slice(0, 200)
      : JSON.stringify(m.content || '').slice(0, 200),
  }));
  return createHash('sha256').update(JSON.stringify(anchor)).digest('hex').slice(0, 16);
}

// ── 工具调用依赖图 ──
export function buildToolCallGraph(messages) {
  const graph = new Map(); // tool_call_id -> true (被引用)
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      graph.set(msg.tool_call_id, true);
    }
  }
  return graph;
}

// ── 消息重要性评分 ──
export function scoreMessage(msg, index, totalCount, toolCallGraph) {
  let score = 0;
  
  // 1. 角色基础权重
  const roleWeight = { system: 100, tool: 70, user: 50, assistant: 30 };
  score += roleWeight[msg.role] || 20;
  
  // 2. 位置衰减
  const recency = totalCount > 1 ? index / (totalCount - 1) : 1;
  score += Math.pow(recency, 0.5) * 50;
  
  // 3. 工具调用链完整性
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const isReferenced = msg.tool_calls.some(tc => toolCallGraph.has(tc.id));
    if (isReferenced) score += 80;
  }
  if (msg.role === 'tool') {
    score += 60;
  }
  
  // 4. 内容信息密度
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
  const contentLen = content.length;
  if (contentLen < 20) score -= 10;
  if (contentLen > 2000) score += 10;
  
  // 5. 关键词提权
  if (typeof msg.content === 'string') {
    if (/```[\s\S]*?```/.test(msg.content)) score += 15;
    if (/\/[\w\-./]+\.\w+/.test(msg.content)) score += 10;
    if (/error|bug|fix|修复|问题|失败/i.test(msg.content)) score += 10;
  }
  
  return score;
}

// ── 智能裁剪 (B) ──
export function structuralTrim(messages, targetCount) {
  const toolCallGraph = buildToolCallGraph(messages);
  
  const scored = messages.map((msg, i) => ({
    msg, index: i,
    score: scoreMessage(msg, i, messages.length, toolCallGraph),
  }));
  
  // 不可裁剪: system 消息 + 最近 keepRecent 轮
  const keepRecentCount = (config.contextTrimKeepRecent || 5) * 2; // 每轮 = user + assistant
  const mandatory = scored.filter(s =>
    s.msg.role === 'system' ||
    s.index >= messages.length - keepRecentCount
  );
  
  const candidates = scored.filter(s => !mandatory.includes(s));
  
  // 按分数降序保留 top-K
  candidates.sort((a, b) => b.score - a.score);
  const keepCount = Math.max(0, targetCount - mandatory.length);
  const kept = candidates.slice(0, keepCount);
  const trimmed = candidates.slice(keepCount);
  
  // 按原始顺序重组
  const result = [...mandatory, ...kept].sort((a, b) => a.index - b.index);
  
  return {
    kept: result.map(s => s.msg),
    trimmedForSummary: trimmed.sort((a, b) => a.index - b.index).map(s => s.msg),
  };
}

// ── 工作记忆提取 (D - 零 API 调用) ──
export function extractWorkingMemory(recentMessages) {
  const parts = [];
  const activeFiles = new Set();
  
  for (const msg of recentMessages) {
    if (msg.role !== 'user') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    
    // 提取文件路径引用
    const files = content.match(/\/[\w\-./]+\.\w+/g);
    if (files) files.forEach(f => activeFiles.add(f));
    
    // 提取任务关键词
    if (/修改|修复|添加|实现|创建|删除|重构|优化|更新|配置/i.test(content)) {
      parts.push(`Current task: ${content.slice(0, 150)}`);
    }
  }
  
  if (activeFiles.size > 0) {
    parts.unshift(`Active files: ${[...activeFiles].slice(0, 10).join(', ')}`);
  }
  
  return parts.length ? parts.join('\n') : null;
}

// ── 摘要生成 (C) ──
function formatMessagesCompact(messages) {
  return messages.map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const truncated = content.length > 500 ? content.slice(0, 500) + '...[truncated]' : content;
    return `[${m.role}]: ${truncated}`;
  }).join('\n\n');
}

async function callLightweightModel(prompt) {
  try {
    const handler = await getHandleChatCompletions();
    const timeoutMs = 5000;
    const resultPromise = handler({
      model: config.contextTrimSummaryModel || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 800,
      temperature: 0.2,
      _internal: true,
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Summary generation timed out')), timeoutMs)
    );
    const result = await Promise.race([resultPromise, timeoutPromise]);
    return result?.body?.choices?.[0]?.message?.content || null;
  } catch (err) {
    log.warn('Lightweight model call failed:', err.message);
    return null;
  }
}

export function validateAndCleanSummary(rawText) {
  if (!rawText) return null;
  // 尝试直接解析
  try {
    JSON.parse(rawText);
    return rawText;
  } catch {}
  // 尝试提取 JSON 块（LLM 可能包裹在 ```json ... ``` 中）
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      JSON.parse(jsonMatch[0]);
      return jsonMatch[0];
    } catch {}
  }
  // 无法提取有效 JSON，作为纯文本摘要返回
  return rawText;
}

async function generateFullSummary(messages) {
  if (!config.contextTrimSummaryEnabled || messages.length === 0) return null;
  
  const prompt = `你是一个对话摘要助手。请将以下对话历史压缩为结构化摘要。

## 对话历史
${formatMessagesCompact(messages)}

## 要求
请输出严格 JSON 格式，包含以下字段：
{
  "goals": ["用户的核心任务目标"],
  "decisions": ["关键技术/设计决策及原因"],
  "codeChanges": ["文件路径 + 改动摘要"],
  "constraints": ["用户提出的限制/偏好"],
  "openIssues": ["待解决的问题"]
}
总字数控制在 600 字以内。只输出 JSON，不要其他文字。`;

  const raw = await callLightweightModel(prompt); return validateAndCleanSummary(raw);
}

async function mergeSummary(existingSummaryJson, newMessages) {
  if (!config.contextTrimSummaryEnabled || newMessages.length === 0) return existingSummaryJson;
  
  const prompt = `你是一个对话摘要助手。下面是已有的对话摘要和新增的对话内容。
请将新信息合并到现有摘要中，保持结构不变。

## 现有摘要
${existingSummaryJson}

## 新增对话
${formatMessagesCompact(newMessages)}

## 要求
1. 保留现有摘要中仍然有效的信息
2. 合并新的目标、决策、代码变更
3. 已完成的 openIssues 移到对应的 decisions 或 codeChanges 中
4. 输出严格 JSON 格式，字段与现有摘要一致
5. 总字数控制在 600 字以内
只输出 JSON，不要其他文字。`;

  const raw = await callLightweightModel(prompt); return validateAndCleanSummary(raw);
}

// ── 主入口 ──
export async function processContext(messages, conversationId) {
  const totalMsgs = messages.filter(m => m.role !== 'system').length;
  
  // Gate: 不需要修剪
  if (totalMsgs < (config.contextTrimThreshold || 12)) {
    return { messages, trimmed: false, strategy: 'none' };
  }
  
  const startTime = Date.now();
  
  // 1. 从 SQLite 加载长期记忆
  const longTermMemory = getMemory(conversationId);
  
  // 2. 规则压缩 (B)
  const { kept, trimmedForSummary } = structuralTrim(messages, 10);
  
  // 3. 提取工作记忆 (D)
  const workingMemory = extractWorkingMemory(kept);
  
  // 4. 摘要处理 (C 混合模式)
  let summaryText = null;
  let strategy = 'structural';
  
  if (config.contextTrimSummaryEnabled && trimmedForSummary.length > 0) {
    try {
      if (longTermMemory && longTermMemory.summary && trimmedForSummary.length <= 2) {
        // 增量合并 (快速路径)
        summaryText = await mergeSummary(longTermMemory.summary, trimmedForSummary);
        strategy = 'hybrid_merge';
      } else if (longTermMemory && longTermMemory.summary && trimmedForSummary.length === 0) {
        // 直接复用缓存 (零延迟路径)
        summaryText = longTermMemory.summary;
        strategy = 'hybrid_cached';
      } else {
        // 完整生成
        summaryText = await generateFullSummary(trimmedForSummary);
        strategy = 'hybrid_full';
      }
    } catch (err) {
      log.warn('Summary generation failed, falling back to structural trim:', err.message);
      strategy = 'structural_fallback';
    }
  }
  
  // 5. 组装最终消息数组
  const systemMsgs = messages.filter(m => m.role === 'system');
  const assembled = [
    ...systemMsgs,
    ...(summaryText ? [{
      role: 'system',
      content: `[Conversation Memory]\n${summaryText}`
    }] : []),
    ...(workingMemory ? [{
      role: 'system',
      content: `[Current Task Context]\n${workingMemory}`
    }] : []),
    ...kept.filter(m => m.role !== 'system'),
  ];
  
  const latencyMs = Date.now() - startTime;
  
  // 6. 记录统计
  try {
    dbRecordTrimStats(conversationId, messages.length, assembled.length, strategy, latencyMs);
  } catch (err) {
    log.debug('Failed to record trim stats:', err.message);
  }
  
  return { messages: assembled, trimmed: true, strategy };
}

// ── 响应后异步更新摘要 ──
export async function postResponseHook(conversationId, originalMessages, assistantText) {
  try {
    if (!config.contextTrimSummaryEnabled) return;
    
    // 保存最近消息到 SQLite（短期记忆持久化）
    const recentCount = (config.contextTrimKeepRecent || 5) * 2;
    const recentMsgs = originalMessages
      .filter(m => m.role !== 'system')
      .slice(-recentCount);
    
    // 加上本次助手回复
    if (assistantText) {
      recentMsgs.push({ role: 'assistant', content: assistantText });
    }
    
    saveRecentMessages(conversationId, recentMsgs);
    
    // 检查是否需要更新长期记忆
    const existing = getMemory(conversationId);
    const totalTurns = Math.floor(originalMessages.filter(m => m.role === 'user').length);
    
    if (!existing || totalTurns - (existing.covered_turns || 0) >= 2) {
      // 需要更新摘要
      const nonSystemMsgs = originalMessages.filter(m => m.role !== 'system');
      
      let newSummary;
      if (existing && existing.summary) {
        // 增量更新
        const uncoveredMsgs = nonSystemMsgs.slice(existing.covered_turns * 2);
        newSummary = await mergeSummary(existing.summary, uncoveredMsgs);
      } else {
        // 首次生成
        newSummary = await generateFullSummary(nonSystemMsgs);
      }
      
      if (newSummary) {
        upsertMemory(conversationId, newSummary, totalTurns, config.contextTrimSummaryModel || 'gpt-4o-mini');
        log.debug(`Updated long-term memory for conversation ${conversationId}, covered_turns=${totalTurns}`);
      }
    }
  } catch (err) {
    log.warn('Post-response hook error:', err.message);
  }
}
