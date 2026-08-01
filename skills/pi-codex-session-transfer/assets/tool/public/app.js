'use strict';

const state = {
  mode: 'codex-to-pi',
  items: [],
  selected: new Set(),
  models: [],
  config: null,
};
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

function isCodexToPi() {
  return state.mode === 'codex-to-pi';
}

function sourceName() {
  return isCodexToPi() ? 'Codex' : 'Pi Agent';
}

function targetName() {
  return isCodexToPi() ? 'Pi' : 'Codex';
}

function filteredItems() {
  const query = $('#search').value.trim().toLowerCase();
  const source = $('#source-filter').value;
  return state.items.filter((item) => {
    if (isCodexToPi() && source !== 'all' && item.source !== source) return false;
    if (!query) return true;
    return [item.title, item.cwd, item.sourcePath].join('\n').toLowerCase().includes(query);
  });
}

function updateControls() {
  const codexToPi = isCodexToPi();
  $('#source-filter-field').hidden = !codexToPi;
  $('#pi-settings').hidden = !codexToPi;
  $('#source-column').textContent = codexToPi ? '来源' : '会话格式';
  for (const button of document.querySelectorAll('.mode-button')) {
    const selected = button.dataset.mode === state.mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function updateButtons() {
  const count = state.selected.size;
  const action = isCodexToPi() ? '导入到 Pi' : '转换到 Codex';
  $('#transfer').disabled = count === 0;
  $('#transfer').textContent = count ? `${action} (${count})` : action;
  $('#summary').textContent = `共 ${state.items.length} 个${sourceName()}会话，已选择 ${count} 个`;
}

function sourceBadge(item) {
  if (!isCodexToPi()) return '<span class="source-badge pi">Pi Agent</span>';
  const active = item.source === 'active';
  return `<span class="source-badge ${active ? 'active' : 'archived'}">${active ? '当前' : '归档'}</span>`;
}

function render() {
  const rows = filteredItems();
  $('#conversation-list').innerHTML = rows.map((item) => `
    <tr data-id="${escapeHtml(item.id)}">
      <td class="check-col"><input class="conversation-check" type="checkbox" data-id="${escapeHtml(item.id)}" ${state.selected.has(item.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.title)}" /></td>
      <td class="title-cell"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.id)}</small></td>
      <td>${item.messageCount ?? '-'}</td>
      <td class="path-cell" title="${escapeHtml(item.cwd)}">${escapeHtml(item.cwd || '-')}</td>
      <td>${formatDate(item.updatedAt)}</td>
      <td>${sourceBadge(item)}</td>
    </tr>
  `).join('');
  $('#empty').hidden = rows.length !== 0;
  $('#select-all').checked = rows.length > 0 && rows.every((item) => state.selected.has(item.id));
  updateButtons();
}

function populateModels() {
  const modelSelect = $('#model');
  modelSelect.innerHTML = state.models.map((model) => {
    const label = `${model.name}${model.reasoning ? ' (reasoning)' : ''}`;
    return `<option value="${escapeHtml(`${model.provider}/${model.id}`)}">${escapeHtml(label)}</option>`;
  }).join('');
  const defaultValue = `${state.config.defaultProvider}/${state.config.defaultModel}`;
  if (state.models.some((model) => `${model.provider}/${model.id}` === defaultValue)) {
    modelSelect.value = defaultValue;
  }
  $('#thinking').value = state.config.defaultThinkingLevel || 'high';
}

async function load() {
  $('#summary').textContent = `正在读取${sourceName()}会话...`;
  const [configResponse, sessionsResponse] = await Promise.all([
    fetch('/api/config'),
    fetch(isCodexToPi() ? '/api/conversations' : '/api/pi-sessions'),
  ]);
  const config = await configResponse.json();
  const sessions = await sessionsResponse.json();
  if (!configResponse.ok || !sessionsResponse.ok || config.error || sessions.error) {
    throw new Error(config.error || sessions.error || '读取会话失败');
  }
  state.config = config;
  state.items = sessions.items || [];
  state.models = config.models || [];
  populateModels();
  updateControls();
  $('#location').textContent = isCodexToPi() ? `Pi: ${config.piAgentDir}` : `Codex: ${config.codexRoot}`;
  render();
}

function setResult(html, isError = false) {
  const result = $('#result');
  result.hidden = false;
  result.className = `result ${isError ? 'error' : 'success'}`;
  result.innerHTML = html;
}

async function transferSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const codexToPi = isCodexToPi();
  $('#transfer').disabled = true;
  $('#transfer').textContent = '正在迁移...';
  try {
    const payload = { ids, includeToolOutput: $('#include-tools').checked };
    if (codexToPi) {
      const [provider, modelId] = $('#model').value.split('/');
      Object.assign(payload, { provider, modelId, thinkingLevel: $('#thinking').value });
    }
    const response = await fetch(codexToPi ? '/api/import' : '/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '迁移失败');
    const completed = codexToPi ? (result.imported || []) : (result.exported || []);
    const failed = result.failed || [];
    const destinationNote = codexToPi
      ? 'Pi Desktop 已打开时，请刷新会话列表或重启后查看。'
      : 'Codex Desktop 已打开时，请刷新任务列表或重启后查看。';
    const lines = [
      `<strong>已迁移 ${completed.length} 个会话到 ${targetName()}</strong>`,
      completed.length ? `<ul>${completed.map((item) => `<li>${escapeHtml(item.title)}<small>${escapeHtml(item.targetPath)}</small></li>`).join('')}</ul>` : '',
      failed.length ? `<div class="failure">失败 ${failed.length} 个：${failed.map((item) => `${escapeHtml(item.title || item.id)} (${escapeHtml(item.error)})`).join('；')}</div>` : '',
      `<span class="muted">${destinationNote}</span>`,
    ];
    setResult(lines.join(''), failed.length > 0 && completed.length === 0);
    state.selected.clear();
    render();
  } catch (error) {
    setResult(escapeHtml(error.message), true);
  } finally {
    updateButtons();
  }
}

function switchMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.selected.clear();
  $('#result').hidden = true;
  updateControls();
  load().catch((error) => setResult(escapeHtml(error.message), true));
}

$('#search').addEventListener('input', render);
$('#source-filter').addEventListener('change', render);
$('#refresh').addEventListener('click', () => load().catch((error) => setResult(escapeHtml(error.message), true)));
$('#select-visible').addEventListener('click', () => {
  for (const item of filteredItems()) state.selected.add(item.id);
  render();
});
$('#clear-selection').addEventListener('click', () => {
  state.selected.clear();
  render();
});
$('#select-all').addEventListener('change', (event) => {
  for (const item of filteredItems()) {
    if (event.target.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
  }
  render();
});
$('#conversation-list').addEventListener('change', (event) => {
  if (!event.target.classList.contains('conversation-check')) return;
  if (event.target.checked) state.selected.add(event.target.dataset.id);
  else state.selected.delete(event.target.dataset.id);
  render();
});
for (const button of document.querySelectorAll('.mode-button')) {
  button.addEventListener('click', () => switchMode(button.dataset.mode));
}
$('#transfer').addEventListener('click', transferSelected);

updateControls();
load().catch((error) => setResult(escapeHtml(error.message), true));
