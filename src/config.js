import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env file manually (zero dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// Derive the default Language Server binary path from the host platform/arch.
// Windsurf ships these filenames inside its tarball. Users can override with
// LS_BINARY_PATH if they keep the binary elsewhere.
function defaultLsBinaryPath() {
  const dir = '/opt/windsurf';
  const { platform, arch } = process;
  // macOS: binaries ship with the .app bundle, but people commonly symlink
  // them to /opt/windsurf as well. Fall through to linux-x64 only if the user
  // didn't vendor the darwin binary.
  if (platform === 'darwin') {
    return `${dir}/language_server_macos_${arch === 'arm64' ? 'arm' : 'x64'}`;
  }
  if (platform === 'win32') {
    return `${dir}\\language_server_windows_x64.exe`;
  }
  // Linux (and anything else unixy)
  return `${dir}/language_server_linux_${arch === 'arm64' ? 'arm' : 'x64'}`;
}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  apiKey: process.env.API_KEY || '',

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Language server — auto-detect default binary name by platform/arch so
  // Windsurf's per-OS LS binaries just work out of the box. User can always
  // override with LS_BINARY_PATH env var.
  lsBinaryPath: process.env.LS_BINARY_PATH || defaultLsBinaryPath(),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  // Dashboard
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // Context trimming / memory
  contextTrimEnabled: (process.env.CONTEXT_TRIM_ENABLED || 'true').toLowerCase() === 'true',
  contextTrimThreshold: parseInt(process.env.CONTEXT_TRIM_THRESHOLD || '12', 10),
  contextTrimKeepRecent: parseInt(process.env.CONTEXT_TRIM_KEEP_RECENT || '5', 10),
  contextTrimSummaryEnabled: (process.env.CONTEXT_TRIM_SUMMARY_ENABLED || 'true').toLowerCase() === 'true',
  contextTrimSummaryModel: process.env.CONTEXT_TRIM_SUMMARY_MODEL || 'gpt-4o-mini',
  contextMemoryTtlHours: parseInt(process.env.CONTEXT_MEMORY_TTL_HOURS || '24', 10),

  // Context trimming V2 — semantic scoring & audit
  contextTrimSemanticEnabled: process.env.CONTEXT_TRIM_SEMANTIC_ENABLED !== 'false',  // 默认 true
  contextTrimEmbeddingModel: process.env.CONTEXT_TRIM_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  contextTrimChunkSize: parseInt(process.env.CONTEXT_TRIM_CHUNK_SIZE) || 1500,
  contextTrimAuditEnabled: process.env.CONTEXT_TRIM_AUDIT_ENABLED !== 'false',  // 默认 true
};

/**
 * 动态更新配置项并持久化到 .env 文件
 * @param {string} envKey - 环境变量名（如 'DASHBOARD_PASSWORD', 'API_KEY'）
 * @param {string} value - 新值
 */
export function updateConfig(envKey, value) {
    const keyMap = {
        'DASHBOARD_PASSWORD': 'dashboardPassword',
        'API_KEY': 'apiKey',
        'CONTEXT_TRIM_ENABLED': 'contextTrimEnabled',
        'CONTEXT_TRIM_THRESHOLD': 'contextTrimThreshold',
        'CONTEXT_TRIM_KEEP_RECENT': 'contextTrimKeepRecent',
        'CONTEXT_TRIM_SUMMARY_ENABLED': 'contextTrimSummaryEnabled',
        'CONTEXT_TRIM_SUMMARY_MODEL': 'contextTrimSummaryModel',
        'CONTEXT_MEMORY_TTL_HOURS': 'contextMemoryTtlHours',
        'CONTEXT_TRIM_SEMANTIC_ENABLED': 'contextTrimSemanticEnabled',
        'CONTEXT_TRIM_EMBEDDING_MODEL': 'contextTrimEmbeddingModel',
        'CONTEXT_TRIM_CHUNK_SIZE': 'contextTrimChunkSize',
        'CONTEXT_TRIM_AUDIT_ENABLED': 'contextTrimAuditEnabled'
    };

    const configKey = keyMap[envKey];
    if (!configKey) throw new Error('Unsupported config key: ' + envKey);

    // 1. 更新内存中的 config (with type coercion for non-string values)
    const boolKeys = ['contextTrimEnabled', 'contextTrimSummaryEnabled', 'contextTrimSemanticEnabled', 'contextTrimAuditEnabled'];
    const intKeys = ['contextTrimThreshold', 'contextTrimKeepRecent', 'contextMemoryTtlHours', 'contextTrimChunkSize'];
    if (boolKeys.includes(configKey)) {
        config[configKey] = String(value).toLowerCase() === 'true';
    } else if (intKeys.includes(configKey)) {
        config[configKey] = parseInt(value, 10);
    } else {
        config[configKey] = value;
    }

    // 2. 持久化到 .env 文件
    const envPath = resolve(ROOT, '.env');

    let envContent = '';
    try {
        envContent = readFileSync(envPath, 'utf-8');
    } catch (e) {
        envContent = '';
    }

    const regex = new RegExp('^' + envKey + '=.*$', 'm');
    if (regex.test(envContent)) {
        envContent = envContent.replace(regex, envKey + '=' + value);
    } else {
        envContent += '\n' + envKey + '=' + value;
    }

    writeFileSync(envPath, envContent, 'utf-8');
}

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
