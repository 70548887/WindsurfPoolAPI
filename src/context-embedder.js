import { createHash } from 'crypto';
import { saveEmbeddings, getEmbeddings } from './context-db.js';
import { config } from './config.js';

// ===== 模型管理 (懒加载) =====

let _pipeline = null;
let _loadError = null;
let _loading = false;  // 防止并发加载

async function getEmbeddingPipeline() {
  if (_loadError) return null;
  if (_pipeline) return _pipeline;
  if (_loading) {
    // 等待正在进行的加载完成
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!_loading) { clearInterval(check); resolve(); }
      }, 100);
    });
    return _pipeline;
  }
  _loading = true;
  try {
    const { pipeline } = await import('@huggingface/transformers');
    const modelName = config.contextTrimEmbeddingModel || 'Xenova/all-MiniLM-L6-v2';
    _pipeline = await pipeline('feature-extraction', modelName, {
      quantized: true,
    });
    console.log(`[context-embedder] Model ${modelName} loaded successfully`);
    return _pipeline;
  } catch (e) {
    _loadError = e;
    console.error('[context-embedder] Model load failed, falling back to V1:', e.message);
    return null;
  } finally {
    _loading = false;
  }
}

// ===== 工具函数 =====

/**
 * 计算内容哈希，用于向量缓存去重
 * 取 role + content 前500字符做 SHA256
 */
export function contentHash(role, content) {
  const text = `${role}:${(content || '').slice(0, 500)}`;
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * 余弦相似度 — 纯JS实现，384维计算 < 0.1ms
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 模型是否就绪
 */
export function isModelReady() {
  return _pipeline !== null;
}

/**
 * 获取模型状态信息 (供 Dashboard)
 */
export function getModelStatus() {
  if (_pipeline) return { status: 'ready', model: config.contextTrimEmbeddingModel || 'Xenova/all-MiniLM-L6-v2' };
  if (_loading) return { status: 'loading', model: config.contextTrimEmbeddingModel || 'Xenova/all-MiniLM-L6-v2' };
  if (_loadError) return { status: 'failed', error: _loadError.message };
  return { status: 'idle', model: config.contextTrimEmbeddingModel || 'Xenova/all-MiniLM-L6-v2' };
}

// ===== Embedding 计算 =====

/**
 * 单条文本 -> Float32Array (384维)
 */
export async function getEmbedding(text) {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return null;
  
  // 截断到 256 tokens 左右 (~900 字符)，避免超长文本
  const truncated = (text || '').slice(0, 900);
  const output = await pipe(truncated, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * 批量文本 -> Float32Array[]
 * 串行处理避免内存峰值
 */
export async function batchEmbed(texts) {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return null;
  
  const results = [];
  for (const text of texts) {
    const truncated = (text || '').slice(0, 900);
    const output = await pipe(truncated, { pooling: 'mean', normalize: true });
    results.push(new Float32Array(output.data));
  }
  return results;
}

// ===== 语义显著性评分 =====

/**
 * 核心函数: 替代 V1 的 scoreMessage()
 * 
 * 算法:
 *   salience = 0.6 * max(cosine_sim(msg_vec, query_vecs))   -- 语义相关性
 *            + 0.25 * (1 - sqrt(position / total))            -- 时间衰减
 *            + 0.15 * role_weight                             -- 角色权重
 * 
 * role_weight: system=1.0, tool=0.7, user=0.5, assistant=0.3
 * 
 * @param {Array} messages - 完整消息数组
 * @param {string} convId - 会话ID
 * @returns {Array<{index, score, message}>}
 */
export async function computeSalienceScores(messages, convId) {
  const ROLE_WEIGHTS = { system: 1.0, tool: 0.7, user: 0.5, assistant: 0.3 };
  const ALPHA = 0.6;   // 语义相关性权重
  const BETA = 0.25;   // 时间衰减权重  
  const GAMMA = 0.15;  // 角色权重

  const keepRecent = (config.contextTrimKeepRecent || 5) * 2;
  const total = messages.length;

  // 1. 提取最近 3 条 user 消息作为查询锚点
  const recentUserMsgs = [];
  for (let i = messages.length - 1; i >= 0 && recentUserMsgs.length < 3; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      recentUserMsgs.push(messages[i].content);
    }
  }
  if (recentUserMsgs.length === 0) {
    // 没有 user 消息，退化为位置+角色评分
    return messages.map((m, i) => ({
      index: i, message: m,
      score: i >= total - keepRecent || m.role === 'system' ? 999 : 
        BETA * (1 - Math.sqrt(i / total)) + GAMMA * (ROLE_WEIGHTS[m.role] || 0.2)
    }));
  }

  // 2. 计算所有消息的 content_hash，查询 DB 缓存
  const hashMap = messages.map((m, i) => ({
    index: i,
    hash: contentHash(m.role, typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
    text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
    role: m.role,
    message: m,
  }));

  const cachedEmbeddings = getEmbeddings(convId);
  
  // 3. 找出未缓存的消息
  const uncached = hashMap.filter(h => !cachedEmbeddings.has(h.hash) && h.text.length > 0);
  
  // 4. 批量计算未缓存消息的 Embedding
  if (uncached.length > 0) {
    const embeddings = await batchEmbed(uncached.map(u => u.text));
    if (embeddings) {
      const entries = uncached.map((u, i) => ({
        contentHash: u.hash,
        role: u.role,
        embedding: embeddings[i],
      }));
      // 保存到缓存
      try {
        saveEmbeddings(convId, entries);
        // 更新本地缓存 map
        entries.forEach(e => cachedEmbeddings.set(e.contentHash, e.embedding));
      } catch (e) {
        console.error('[context-embedder] Failed to save embeddings:', e.message);
      }
    }
  }

  // 5. 计算 query 锚点的 Embedding
  const queryEmbeddings = [];
  for (const qText of recentUserMsgs) {
    const qHash = contentHash('user', qText);
    if (cachedEmbeddings.has(qHash)) {
      queryEmbeddings.push(cachedEmbeddings.get(qHash));
    } else {
      const vec = await getEmbedding(qText);
      if (vec) queryEmbeddings.push(vec);
    }
  }

  // 6. 对每条消息计算 salience score
  const scored = hashMap.map((h, idx) => {
    // 强制保护: system 消息和最近 keepRecent 条
    if (h.message.role === 'system' || idx >= total - keepRecent) {
      return { index: h.index, score: 999, message: h.message };
    }

    // 语义相关性: 与所有 query 锚点的最大余弦相似度
    let maxSim = 0;
    const msgVec = cachedEmbeddings.get(h.hash);
    if (msgVec && queryEmbeddings.length > 0) {
      for (const qVec of queryEmbeddings) {
        const sim = cosineSimilarity(msgVec, qVec);
        if (sim > maxSim) maxSim = sim;
      }
    }

    // 时间衰减
    const recency = 1 - Math.sqrt(idx / total);

    // 角色权重
    const roleW = ROLE_WEIGHTS[h.message.role] || 0.2;

    const score = ALPHA * maxSim + BETA * recency + GAMMA * roleW;

    return { index: h.index, score, message: h.message };
  });

  return scored;
}
