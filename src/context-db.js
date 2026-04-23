import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config, log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// 确保 data 目录存在
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, 'context-memory.db');
const db = new Database(DB_PATH);

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_memory (
    conversation_id TEXT PRIMARY KEY,
    summary         TEXT NOT NULL,
    summary_version INTEGER DEFAULT 0,
    covered_turns   INTEGER DEFAULT 0,
    model           TEXT,
    last_trim_hash  TEXT,
    last_trim_time  INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recent_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    turn_index      INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    has_tool_calls  INTEGER DEFAULT 0,
    char_count      INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recent_conv ON recent_messages(conversation_id, turn_index);

  CREATE TABLE IF NOT EXISTS trim_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    original_count  INTEGER,
    trimmed_count   INTEGER,
    strategy_used   TEXT,
    summary_latency_ms INTEGER,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_embeddings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    role            TEXT NOT NULL,
    embedding       BLOB NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE(conversation_id, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_embed_conv ON message_embeddings(conversation_id);

  CREATE TABLE IF NOT EXISTS trim_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    original_hash   TEXT NOT NULL,
    original_data   TEXT NOT NULL,
    trimmed_count   INTEGER NOT NULL,
    strategy        TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    rolled_back     INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_audit_conv ON trim_audit_log(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS request_debug_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    model           TEXT NOT NULL,
    message_count   INTEGER NOT NULL,
    assembled_data  TEXT NOT NULL,
    strategy        TEXT,
    response_status TEXT DEFAULT 'pending',
    error_type      TEXT,
    error_message   TEXT,
    latency_ms      INTEGER,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reqlog_status ON request_debug_log(response_status, created_at);
`);

// 兼容已存在的表：尝试添加新列（忽略"已存在"错误）
try { db.exec('ALTER TABLE conversation_memory ADD COLUMN last_trim_hash TEXT'); } catch (_) { /* column already exists */ }
try { db.exec('ALTER TABLE conversation_memory ADD COLUMN last_trim_time INTEGER'); } catch (_) { /* column already exists */ }

// 预编译 SQL 语句
const stmts = {
  getMemory: db.prepare('SELECT * FROM conversation_memory WHERE conversation_id = ?'),
  upsertMemory: db.prepare(`
    INSERT INTO conversation_memory (conversation_id, summary, summary_version, covered_turns, model, last_trim_hash, last_trim_time, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      summary = excluded.summary,
      summary_version = summary_version + 1,
      covered_turns = excluded.covered_turns,
      model = excluded.model,
      last_trim_hash = excluded.last_trim_hash,
      last_trim_time = excluded.last_trim_time,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `),
  getRecentMessages: db.prepare('SELECT * FROM recent_messages WHERE conversation_id = ? ORDER BY turn_index ASC'),
  saveRecentMessage: db.prepare(`
    INSERT INTO recent_messages (conversation_id, turn_index, role, content, has_tool_calls, char_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  deleteRecentMessages: db.prepare('DELETE FROM recent_messages WHERE conversation_id = ?'),
  recordTrimStats: db.prepare(`
    INSERT INTO trim_stats (conversation_id, original_count, trimmed_count, strategy_used, summary_latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getTrimStats: db.prepare(`
    SELECT strategy_used, COUNT(*) as count, AVG(original_count) as avg_original,
           AVG(trimmed_count) as avg_trimmed, AVG(summary_latency_ms) as avg_latency
    FROM trim_stats GROUP BY strategy_used
  `),
  getRecentTrimEvents: db.prepare('SELECT * FROM trim_stats ORDER BY created_at DESC LIMIT 20'),
  getActiveConversations: db.prepare('SELECT conversation_id, summary_version, covered_turns, model, updated_at FROM conversation_memory WHERE expires_at > ? ORDER BY updated_at DESC'),
  deleteMemory: db.prepare('DELETE FROM conversation_memory WHERE conversation_id = ?'),
  deleteEmbeddings: db.prepare('DELETE FROM message_embeddings WHERE conversation_id = ?'),
  deleteAuditLogs: db.prepare('DELETE FROM trim_audit_log WHERE conversation_id = ?'),
  cleanExpired: db.prepare('DELETE FROM conversation_memory WHERE expires_at < ?'),
  cleanOrphanMessages: db.prepare('DELETE FROM recent_messages WHERE conversation_id NOT IN (SELECT conversation_id FROM conversation_memory)'),
  cleanOldStats: db.prepare('DELETE FROM trim_stats WHERE created_at < ?'),
  cleanOldEmbeddings: db.prepare('DELETE FROM message_embeddings WHERE created_at < ?'),
  cleanOldAuditUnrolled: db.prepare('DELETE FROM trim_audit_log WHERE created_at < ? AND rolled_back = 0'),
  cleanOldAuditAll: db.prepare('DELETE FROM trim_audit_log WHERE created_at < ?'),
  countActiveConversations: db.prepare('SELECT COUNT(*) as count FROM conversation_memory WHERE expires_at > ?'),
  totalTrimCount: db.prepare('SELECT COUNT(*) as count FROM trim_stats'),
};

// 导出 CRUD 函数
export function getMemory(conversationId) {
  return stmts.getMemory.get(conversationId) || null;
}

export function upsertMemory(conversationId, summary, coveredTurns, model, trimmedHash) {
  const now = Date.now();
  const ttlMs = (config.contextMemoryTtlHours || 24) * 3600000;
  stmts.upsertMemory.run(conversationId, summary, 0, coveredTurns, model, trimmedHash || null, trimmedHash ? now : null, now, now, now + ttlMs);
}

export function getRecentMessages(conversationId) {
  return stmts.getRecentMessages.all(conversationId);
}

export function saveRecentMessages(conversationId, messages) {
  stmts.deleteRecentMessages.run(conversationId);
  const saveMany = db.transaction((msgs) => {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const hasToolCalls = (m.tool_calls && m.tool_calls.length > 0) ? 1 : 0;
      stmts.saveRecentMessage.run(conversationId, i, m.role, content, hasToolCalls, content.length, Date.now());
    }
  });
  saveMany(messages);
}

export function recordTrimStats(conversationId, originalCount, trimmedCount, strategyUsed, summaryLatencyMs = 0) {
  stmts.recordTrimStats.run(conversationId, originalCount, trimmedCount, strategyUsed, summaryLatencyMs, Date.now());
}

export function getTrimStats() {
  return stmts.getTrimStats.all();
}

export function getRecentTrimEvents() {
  return stmts.getRecentTrimEvents.all();
}

export function getActiveConversations() {
  return stmts.getActiveConversations.all(Date.now());
}

export function deleteMemory(conversationId) {
  stmts.deleteMemory.run(conversationId);
  stmts.deleteRecentMessages.run(conversationId);
  stmts.deleteEmbeddings.run(conversationId);
  stmts.deleteAuditLogs.run(conversationId);
}

export function getContextMemoryOverview() {
  const active = stmts.countActiveConversations.get(Date.now());
  const total = stmts.totalTrimCount.get();
  const byStrategy = stmts.getTrimStats.all();
  return {
    activeConversations: active?.count || 0,
    totalTrimCount: total?.count || 0,
    byStrategy,
  };
}

// === Embedding 缓存函数 ===

export function saveEmbeddings(conversationId, entries) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO message_embeddings
    (conversation_id, content_hash, role, embedding, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const e of entries) {
      const buf = Buffer.from(e.embedding.buffer);
      stmt.run(conversationId, e.contentHash, e.role, buf, now);
    }
  });
  tx();
}

export function getEmbeddings(conversationId) {
  const rows = db.prepare(`SELECT content_hash, embedding FROM message_embeddings
    WHERE conversation_id = ?`).all(conversationId);
  const map = new Map();
  for (const row of rows) {
    map.set(row.content_hash, new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength
    )));
  }
  return map;
}

export function cleanEmbeddings(conversationId) {
  db.prepare(`DELETE FROM message_embeddings WHERE conversation_id = ?`).run(conversationId);
}

// === 审计日志函数 ===

export function saveAuditLog(conversationId, originalHash, originalData, trimmedCount, strategy) {
  db.prepare(`INSERT INTO trim_audit_log
    (conversation_id, original_hash, original_data, trimmed_count, strategy, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    conversationId, originalHash, originalData, trimmedCount, strategy, Date.now()
  );
}

export function getAuditLogs(conversationId) {
  return db.prepare(`SELECT * FROM trim_audit_log WHERE conversation_id = ?
    ORDER BY created_at DESC`).all(conversationId);
}

export function getRecentAuditLogs(limit = 20) {
  return db.prepare(`SELECT * FROM trim_audit_log
    ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function markRolledBack(auditId) {
  db.prepare(`UPDATE trim_audit_log SET rolled_back = 1 WHERE id = ?`).run(auditId);
}

// === 请求调试日志函数 ===

export function saveRequestLog(convId, model, messageCount, assembledData, strategy) {
  return db.prepare(`INSERT INTO request_debug_log
    (conversation_id, model, message_count, assembled_data, strategy, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(convId, model, messageCount, assembledData, strategy, Date.now()).lastInsertRowid;
}

export function updateRequestLog(logId, status, errorType, errorMessage, latencyMs) {
  db.prepare(`UPDATE request_debug_log
    SET response_status=?, error_type=?, error_message=?, latency_ms=?
    WHERE id=?`).run(status, errorType, errorMessage, latencyMs, logId);
}

export function getRecentRequestLogs(limit = 20) {
  return db.prepare(`SELECT id, conversation_id, model, message_count, strategy,
    response_status, error_type, error_message, latency_ms, created_at
    FROM request_debug_log ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function getRequestLogDetail(logId) {
  return db.prepare(`SELECT * FROM request_debug_log WHERE id = ?`).get(logId);
}

// 自动清理
function cleanup() {
  try {
    const now = Date.now();
    stmts.cleanExpired.run(now);
    stmts.cleanOrphanMessages.run();
    stmts.cleanOldStats.run(now - 7 * 86400000);
    // 清理7天前的 embedding 缓存
    stmts.cleanOldEmbeddings.run(now - 7 * 24 * 3600 * 1000);
    // 清理30天前的审计日志 (未回滚的)
    stmts.cleanOldAuditUnrolled.run(now - 30 * 24 * 3600 * 1000);
    // 清理90天前的所有审计日志
    stmts.cleanOldAuditAll.run(now - 90 * 24 * 3600 * 1000);
    // 清理7天前成功的请求日志，保留30天的错误日志
    db.prepare('DELETE FROM request_debug_log WHERE response_status = ? AND created_at < ?').run('success', now - 7 * 24 * 3600 * 1000);
    db.prepare('DELETE FROM request_debug_log WHERE created_at < ?').run(now - 30 * 24 * 3600 * 1000);
    log.debug('Context memory cleanup completed');
  } catch (err) {
    log.warn('Context memory cleanup error:', err.message);
  }
}

// 启动时清理一次，之后每小时
cleanup();
const _cleanupTimer = setInterval(cleanup, 3600000);

// 优雅关闭
export function closeDb() {
  clearInterval(_cleanupTimer);
  db.close();
}

log.info(`Context memory DB initialized at ${DB_PATH}`);
