import { createHash } from 'crypto';
import { saveEmbeddings, getEmbeddings } from './context-db.js';
import { config } from './config.js';

// ===== 模型管理 (懒加载) =====

let _pipeline = null;
let _loadError = null;
let _loading = false;  // 防止并发加载

// 内存级 LRU 缓存（减少 DB 查询）
const LRU_CACHE = new Map();
const LRU_MAX = 500;

function getCachedEmbedding(hash) {
  if (LRU_CACHE.has(hash)) {
    const entry = LRU_CACHE.get(hash);
    LRU_CACHE.delete(hash);
    LRU_CACHE.set(hash, entry); // 刷新 LRU 位置
    return entry;
  }
  return null;
}

function setCachedEmbedding(hash, embedding) {
  if (LRU_CACHE.size >= LRU_MAX) {
    const oldest = LRU_CACHE.keys().next().value;
    LRU_CACHE.delete(oldest);
  }
  LRU_CACHE.set(hash, embedding);
}

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

/**
 * 预加载 Embedding 模型（用于服务启动时调用）
 * 失败时返回 false，不影响服务启动
 */
export async function preloadEmbeddingModel(timeoutMs = 60000) {
  const startTime = Date.now();
  try {
    if (_pipeline || _loading) return isModelReady();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Preload timeout')), timeoutMs)
    );
    await Promise.race([getEmbeddingPipeline(), timeoutPromise]);
    const elapsedMs = Date.now() - startTime;
    console.log(`[context-embedder] Preload completed in ${elapsedMs}ms, ready=${isModelReady()}`);
    return isModelReady();
  } catch (e) {
    console.warn(`[context-embedder] Preload failed after ${Date.now() - startTime}ms:`, e.message);
    return false;
  }
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
 * 分批并行处理，每批 batchSize 条并发
 */
export async function batchEmbed(texts, batchSize = 8) {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return null;
  
  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(text => getEmbedding(text))
    );
    results.push(...batchResults);
  }
  return results;
}

// ===== 语义显著性评分 =====

/**
 * 角色权重 — 细化不同角色的重要性
 * system > user > tool_calls(assistant) > tool > assistant > 其他
 */
export function getRoleWeight(msg) {
  if (msg.role === 'system') return 1.0;
  if (msg.role === 'user') return 0.9;
  if (msg.role === 'tool') return 0.8;
  if (msg.tool_calls) return 0.85;
  if (msg.role === 'assistant') return 0.6;
  return 0.5;
}

/**
 * 核心函数: 替代 V1 的 scoreMessage()
 * 
 * 算法:
 *   salience = 0.45 * max(cosine_sim(msg_vec, query_vecs))   -- 语义相关性
 *            + 0.30 * (1 - position / total)                   -- 时间衰减（线性）
 *            + 0.25 * role_weight                              -- 角色权重
 * 
 * role_weight: system=1.0, user=0.9, tool_calls=0.85, tool=0.8, assistant=0.6
 * 
 * @param {Array} messages - 完整消息数组
 * @param {string} convId - 会话ID
 * @returns {Array<{index, score, message}>}
 */
export async function computeSalienceScores(messages, convId) {
  const ALPHA = 0.45;  // 语义相关性（降低，避免过度依赖语义）
  const BETA = 0.30;   // 时间衰减（提升，更重视近期消息）
  const GAMMA = 0.25;  // 角色权重（提升，保护工具链和关键角色）

  const avgMsgsPerTurn = Math.ceil(messages.length / Math.max(1, messages.filter(m => m.role === 'user').length));
  const keepRecent = (config.contextTrimKeepRecent || 5) * avgMsgsPerTurn;
  const total = messages.length;

  // 1. 动态确定查询锚点数量，提取最近 user 消息作为查询锚点
  const userMsgCount = messages.filter(m => m.role === 'user').length;
  const anchorCount = Math.max(1, Math.min(3, Math.ceil(userMsgCount / 3)));
  const recentUserMsgs = [];
  for (let i = messages.length - 1; i >= 0 && recentUserMsgs.length < anchorCount; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      recentUserMsgs.push(messages[i].content);
    }
  }
  if (recentUserMsgs.length === 0) {
    // 没有 user 消息，退化为位置+角色评分
    return messages.map((m, i) => ({
      index: i, message: m,
      score: i >= total - keepRecent || m.role === 'system' ? 999 : 
        BETA * (1 - (i / total)) + GAMMA * getRoleWeight(m)
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
  
  // 3. 三级缓存查找：LRU内存 -> DB缓存 -> 计算
  const needsCompute = [];
  for (const h of hashMap) {
    if (h.text.length === 0) continue;
    
    // Level 1: 内存 LRU 缓存
    let embedding = getCachedEmbedding(h.hash);
    if (embedding) {
      cachedEmbeddings.set(h.hash, embedding);
      continue;
    }
    
    // Level 2: DB 缓存
    const dbCached = cachedEmbeddings.get(h.hash);
    if (dbCached) {
      setCachedEmbedding(h.hash, dbCached);
      continue;
    }
    
    // Level 3: 需要计算
    needsCompute.push({ hash: h.hash, text: h.text, role: h.role });
  }
  
  // 4. 批量计算未缓存消息的 Embedding
  if (needsCompute.length > 0) {
    const embeddings = await batchEmbed(needsCompute.map(n => n.text));
    if (embeddings) {
      const entries = needsCompute.map((n, i) => ({
        contentHash: n.hash,
        role: n.role,
        embedding: embeddings[i],
      }));
      // 保存到 DB 缓存 + LRU 缓存
      try {
        saveEmbeddings(convId, entries);
        entries.forEach(e => {
          cachedEmbeddings.set(e.contentHash, e.embedding);
          setCachedEmbedding(e.contentHash, e.embedding);
        });
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

    // 时间衰减（线性）
    const recency = 1 - (idx / total);

    // 角色权重
    const roleW = getRoleWeight(h.message);

    const score = ALPHA * maxSim + BETA * recency + GAMMA * roleW;

    return { index: h.index, score, message: h.message };
  });

  return scored;
}
