'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const CODEX_ROOT = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PI_AGENT_CANDIDATES = [
  process.env.PI_CODING_AGENT_DIR,
  'D:\\Pi\\agent',
  path.join(os.homedir(), '.pi', 'agent'),
].filter(Boolean);
const PI_AGENT_DIR = PI_AGENT_CANDIDATES.find((candidate) => (
  fs.existsSync(path.join(candidate, 'sessions')) ||
  fs.existsSync(path.join(candidate, 'settings.json')) ||
  fs.existsSync(path.join(candidate, 'models.json'))
)) || PI_AGENT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || PI_AGENT_CANDIDATES.at(-1);
const PORT = Number(process.env.CODEX_TO_PI_PORT || 38711);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SERVICE_ID = 'pi-codex-session-transfer';
const TOOL_VERSION = '1.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let conversationCache = { at: 0, items: [] };
let piConversationCache = { at: 0, items: [] };

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  const records = [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return records;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially written session line should not prevent other sessions loading.
    }
  }
  return records;
}

function walkJsonl(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const result = [];
  const pending = [rootDir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(fullPath);
    }
  }
  return result;
}

function readCodexSessionMeta(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const chunks = [];
    let offset = 0;
    while (offset < 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      const chunk = buffer.subarray(0, bytes);
      const newline = chunk.indexOf(10);
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      offset += bytes;
    }
    const firstLine = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
    const record = JSON.parse(firstLine);
    return record.type === 'session_meta' && record.payload ? record.payload : {};
  } catch {
    return {};
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const part of content) {
    if (typeof part === 'string') {
      pieces.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') pieces.push(part.text);
    else if (typeof part.output_text === 'string') pieces.push(part.output_text);
    else if (part.type === 'input_image' || part.type === 'output_image') pieces.push('[图片附件]');
  }
  return pieces.join('\n').trim();
}

function valueToText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isInjectedContext(text) {
  return text.startsWith('# AGENTS.md instructions') ||
    text.includes('<environment_context>') ||
    text.includes('"workspace_roots"') ||
    (text.includes('You are Codex') && text.includes('# General'));
}

function parseCodexFile(filePath, includeToolOutput = false) {
  const records = readJsonLines(filePath);
  let meta = {};
  const responseMessages = [];
  const eventMessages = [];
  const toolMessages = [];

  for (const record of records) {
    if (record.type === 'session_meta' && record.payload) {
      meta = { ...meta, ...record.payload };
      continue;
    }

    const payload = record.payload || {};
    const timestamp = record.timestamp || payload.timestamp || meta.timestamp || new Date().toISOString();

    if (record.type === 'response_item') {
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        const text = contentToText(payload.content);
        if (text) {
          responseMessages.push({ role: payload.role, text, timestamp });
        }
      } else if (includeToolOutput &&
        (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
        const text = valueToText(payload.output ?? payload.result ?? payload.content);
        if (text) toolMessages.push({ role: 'tool', text, timestamp });
      }
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = valueToText(payload.message);
        if (text) eventMessages.push({ role: 'user', text, timestamp });
      } else if (payload.type === 'agent_message') {
        const text = valueToText(payload.message);
        if (text) eventMessages.push({ role: 'assistant', text, timestamp });
      }
    }
  }

  const visibleMessages = eventMessages.length
    ? eventMessages
    : responseMessages.filter((message) => !isInjectedContext(message.text));
  const messages = [...visibleMessages, ...toolMessages];
  messages.sort((a, b) => safeDate(a.timestamp).getTime() - safeDate(b.timestamp).getTime());
  return { meta, messages };
}

function readSessionIndex() {
  const indexPath = path.join(CODEX_ROOT, 'session_index.jsonl');
  const index = new Map();
  for (const record of readJsonLines(indexPath)) {
    if (record.id) index.set(record.id, record);
  }
  return index;
}

function sourceType(filePath) {
  return filePath.includes(`${path.sep}archived_sessions${path.sep}`) ? 'archived' : 'active';
}

function safeDate(value, fallback) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback || Date.now()) : date;
}

function scanConversations() {
  const now = Date.now();
  if (now - conversationCache.at < 5000) return conversationCache.items;
  const index = readSessionIndex();
  const roots = [
    { dir: path.join(CODEX_ROOT, 'sessions'), source: 'active' },
    { dir: path.join(CODEX_ROOT, 'archived_sessions'), source: 'archived' },
  ];
  const items = [];
  for (const root of roots) {
    for (const filePath of walkJsonl(root.dir)) {
      const stat = fs.statSync(filePath);
      const meta = readCodexSessionMeta(filePath);
      const id = meta.session_id || path.basename(filePath, '.jsonl');
      const indexed = index.get(id) || {};
      const firstUser = undefined;
      const updatedAt = safeDate(indexed.updated_at || stat.mtime.toISOString(), stat.mtime.toISOString());
      items.push({
        id,
        title: indexed.thread_name || firstUser?.text?.replace(/\s+/g, ' ').slice(0, 80) || '未命名对话',
        cwd: meta.cwd || '',
        createdAt: safeDate(meta.timestamp || stat.birthtime.toISOString(), stat.birthtime.toISOString()).toISOString(),
        updatedAt: updatedAt.toISOString(),
        messageCount: null,
        source: root.source,
        sourcePath: filePath,
      });
    }
  }

  const unique = new Map();
  for (const item of items) {
    const existing = unique.get(item.id);
    if (!existing || (existing.source === 'archived' && item.source === 'active')) unique.set(item.id, item);
  }
  conversationCache = {
    at: now,
    items: [...unique.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  return conversationCache.items;
}

function parsePiFile(filePath, includeToolOutput = false) {
  const records = readJsonLines(filePath);
  const meta = {};
  const messages = [];

  for (const record of records) {
    if (record.type === 'session') {
      Object.assign(meta, record);
      continue;
    }
    if (record.type !== 'message' || !record.message) continue;

    const message = record.message;
    const timestamp = record.timestamp || message.timestamp || meta.timestamp || new Date().toISOString();
    if (message.role === 'user' || message.role === 'assistant') {
      const text = contentToText(message.content);
      if (text) messages.push({ role: message.role, text, timestamp });
      continue;
    }
    if (includeToolOutput && message.role === 'toolResult') {
      const text = contentToText(message.content);
      if (text) {
        messages.push({
          role: 'tool',
          text: `[Pi tool result${message.toolName ? `: ${message.toolName}` : ''}]\n${text}`,
          timestamp,
        });
      }
    }
  }

  return { meta, messages };
}

function conversationTitle(messages, fallback) {
  const firstUser = messages.find((message) => message.role === 'user');
  return firstUser?.text?.replace(/\s+/g, ' ').slice(0, 80) || fallback;
}

function scanPiSessions() {
  const now = Date.now();
  if (now - piConversationCache.at < 5000) return piConversationCache.items;

  const items = [];
  for (const filePath of walkJsonl(path.join(PI_AGENT_DIR, 'sessions'))) {
    const parsed = parsePiFile(filePath);
    if (!parsed.messages.length) continue;
    const stat = fs.statSync(filePath);
    const id = parsed.meta.id || path.basename(filePath, '.jsonl');
    items.push({
      id,
      title: conversationTitle(parsed.messages, 'Untitled Pi session'),
      cwd: parsed.meta.cwd || '',
      createdAt: safeDate(parsed.meta.timestamp || stat.birthtime.toISOString(), stat.birthtime.toISOString()).toISOString(),
      updatedAt: stat.mtime.toISOString(),
      messageCount: parsed.messages.length,
      source: 'pi',
      sourcePath: filePath,
    });
  }
  piConversationCache = {
    at: now,
    items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  return piConversationCache.items;
}

function loadPiConfig() {
  const settings = readJson(path.join(PI_AGENT_DIR, 'settings.json'), {});
  const modelConfig = readJson(path.join(PI_AGENT_DIR, 'models.json'), { providers: {} });
  const models = [];
  for (const [provider, config] of Object.entries(modelConfig.providers || {})) {
    for (const model of config.models || []) {
      models.push({
        provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
      });
    }
  }
  return {
    defaultProvider: settings.defaultProvider || models[0]?.provider || '',
    defaultModel: settings.defaultModel || models[0]?.id || '',
    defaultThinkingLevel: settings.defaultThinkingLevel || 'high',
    models,
  };
}

function sanitizeCwd(cwd) {
  const value = String(cwd || 'C:\\').replace(/[:\\/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
  return `--${value}--`;
}

function timestampForFile(date) {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '.000Z');
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function writePiSession(item, config, includeToolOutput) {
  const parsed = parseCodexFile(item.sourcePath, includeToolOutput);
  if (!parsed.messages.length) throw new Error('没有找到可迁移的可见消息');

  const now = new Date();
  const sessionId = crypto.randomUUID();
  const modelChangeId = crypto.randomUUID();
  const thinkingChangeId = crypto.randomUUID();
  const cwd = parsed.meta.cwd || process.cwd();
  const provider = config.provider || loadPiConfig().defaultProvider;
  const modelId = config.modelId || loadPiConfig().defaultModel;
  const thinkingLevel = config.thinkingLevel || loadPiConfig().defaultThinkingLevel || 'high';
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: now.toISOString(), cwd },
    { type: 'model_change', id: modelChangeId, parentId: null, timestamp: now.toISOString(), provider, modelId },
    { type: 'thinking_level_change', id: thinkingChangeId, parentId: modelChangeId, timestamp: now.toISOString(), thinkingLevel },
  ];
  let parentId = thinkingChangeId;
  for (const sourceMessage of parsed.messages) {
    const messageId = crypto.randomUUID();
    const timestamp = safeDate(sourceMessage.timestamp, now.toISOString());
    const role = sourceMessage.role === 'tool' ? 'user' : sourceMessage.role;
    const text = sourceMessage.role === 'tool'
      ? `[Codex 工具结果]\n${sourceMessage.text}`
      : sourceMessage.text;
    const message = {
      role,
      content: [{ type: 'text', text }],
      timestamp: timestamp.getTime(),
    };
    if (role === 'assistant') {
      Object.assign(message, {
        api: 'openai-completions',
        provider,
        model: modelId,
        usage: emptyUsage(),
        stopReason: 'stop',
      });
    }
    lines.push({
      type: 'message',
      id: messageId,
      parentId,
      timestamp: timestamp.toISOString(),
      message,
    });
    parentId = messageId;
  }

  const folder = path.join(PI_AGENT_DIR, 'sessions', sanitizeCwd(cwd));
  fs.mkdirSync(folder, { recursive: true });
  const fileName = `${timestampForFile(safeDate(parsed.meta.timestamp, now.toISOString()))}_${sessionId}.jsonl`;
  const targetPath = path.join(folder, fileName);
  fs.writeFileSync(targetPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return { targetPath, messageCount: parsed.messages.length, sessionId };
}

function formatCodexFileTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function codexSessionFolder(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return path.join(CODEX_ROOT, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
}

function codexResponseItem(role, text, timestamp, turnId) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      ...(role === 'assistant' ? { phase: 'final' } : {}),
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function buildCodexSessionLines(parsed, sessionId, importedAt) {
  const turnId = crypto.randomUUID();
  const cwd = parsed.meta.cwd || process.cwd();
  const metaTimestamp = importedAt.toISOString();
  const lines = [
    {
      timestamp: metaTimestamp,
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: metaTimestamp,
        cwd,
        originator: 'Codex to Pi Importer',
        cli_version: 'local-session-import',
        source: 'import',
        thread_source: 'pi-agent',
        model_provider: 'OpenAI',
        history_mode: 'imported',
        context_window: { window_id: crypto.randomUUID() },
      },
    },
    {
      timestamp: metaTimestamp,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        started_at: metaTimestamp,
        model_context_window: 0,
        collaboration_mode_kind: 'default',
      },
    },
  ];

  for (const sourceMessage of parsed.messages) {
    const timestamp = safeDate(sourceMessage.timestamp, importedAt).toISOString();
    const role = sourceMessage.role === 'assistant' ? 'assistant' : 'user';
    const text = sourceMessage.text;
    if (role === 'user') {
      lines.push(codexResponseItem('user', text, timestamp, turnId));
      lines.push({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: crypto.randomUUID(),
          message: text,
          images: [],
          local_images: [],
          audio: [],
          local_audio: [],
          text_elements: [],
        },
      });
    } else {
      lines.push({
        timestamp,
        type: 'event_msg',
        payload: { type: 'agent_message', message: text, phase: 'final', memory_citation: null },
      });
      lines.push(codexResponseItem('assistant', text, timestamp, turnId));
    }
  }
  return lines;
}

function writeCodexSession(item, includeToolOutput) {
  const parsed = parsePiFile(item.sourcePath, includeToolOutput);
  if (!parsed.messages.length) throw new Error('No visible messages found in the Pi session.');

  const importedAt = new Date();
  const sessionId = crypto.randomUUID();
  const folder = codexSessionFolder(importedAt);
  const targetPath = path.join(folder, `rollout-${formatCodexFileTimestamp(importedAt)}-${sessionId}.jsonl`);
  const title = `Pi - ${conversationTitle(parsed.messages, 'Imported Pi session')}`;
  const lines = buildCodexSessionLines(parsed, sessionId, importedAt);

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(targetPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  fs.appendFileSync(
    path.join(CODEX_ROOT, 'session_index.jsonl'),
    `${JSON.stringify({ id: sessionId, thread_name: title, updated_at: importedAt.toISOString() })}\n`,
    'utf8',
  );
  conversationCache = { at: 0, items: [] };
  return { targetPath, messageCount: parsed.messages.length, sessionId, title };
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) reject(new Error('请求过大'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求 JSON 无效')); }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      sendJson(response, 200, {
        ...loadPiConfig(),
        service: SERVICE_ID,
        version: TOOL_VERSION,
        piAgentDir: PI_AGENT_DIR,
        piAgentAvailable: fs.existsSync(PI_AGENT_DIR),
        codexRoot: CODEX_ROOT,
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/conversations') {
      const items = scanConversations();
      sendJson(response, 200, { items, count: items.length });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/pi-sessions') {
      const items = scanPiSessions();
      sendJson(response, 200, { items, count: items.length });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/import') {
      const body = await parseBody(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
      const items = scanConversations();
      const byId = new Map(items.map((item) => [item.id, item]));
      const config = {
        provider: String(body.provider || ''),
        modelId: String(body.modelId || ''),
        thinkingLevel: String(body.thinkingLevel || ''),
      };
      const imported = [];
      const failed = [];
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) {
          failed.push({ id, error: '找不到源会话' });
          continue;
        }
        try {
          const result = writePiSession(item, config, Boolean(body.includeToolOutput));
          imported.push({ id, title: item.title, sourcePath: item.sourcePath, ...result });
        } catch (error) {
          failed.push({ id, title: item.title, error: error.message });
        }
      }
      sendJson(response, 200, { imported, failed, piAgentDir: PI_AGENT_DIR });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/export') {
      const body = await parseBody(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
      const items = scanPiSessions();
      const byId = new Map(items.map((item) => [item.id, item]));
      const exported = [];
      const failed = [];
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) {
          failed.push({ id, error: 'Pi session not found.' });
          continue;
        }
        try {
          const result = writeCodexSession(item, Boolean(body.includeToolOutput));
          exported.push({ id, title: item.title, sourcePath: item.sourcePath, ...result });
        } catch (error) {
          failed.push({ id, title: item.title, error: error.message });
        }
      }
      sendJson(response, 200, { exported, failed, codexRoot: CODEX_ROOT });
      return;
    }
    if (request.method === 'GET') {
      serveStatic(request, response, requestUrl.pathname);
      return;
    }
    response.writeHead(405);
    response.end('Method not allowed');
  } catch (error) {
    sendJson(response, 500, { error: error.message || '服务器错误' });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Codex to Pi running at http://127.0.0.1:${PORT}`);
    console.log(`Codex source: ${CODEX_ROOT}`);
    console.log(`Pi target: ${PI_AGENT_DIR}`);
  });
}

module.exports = {
  buildCodexSessionLines,
  parseCodexFile,
  parsePiFile,
  scanConversations,
  scanPiSessions,
  writeCodexSession,
  writePiSession,
};
