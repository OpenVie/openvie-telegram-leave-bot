import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const ENV_FILE = '.env';
const SUBMISSIONS_FILE = 'submissions.json';
const UPDATE_OFFSET_FILE = 'update-offset.json';
const CHAT_SESSIONS_FILE = 'chat-sessions.json';

class ServiceError extends Error {}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorLabel(error) {
  return error instanceof ServiceError ? error.message : 'unexpected error';
}

async function readEnvFile() {
  let source;
  try {
    source = await readFile(ENV_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ServiceError('Missing .env. Copy .env.example to .env and fill in the values.');
    }
    throw new ServiceError('Cannot read .env.');
  }

  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function buildConfig(values) {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'OPENVIE_API_KEY',
    'OPENVIE_BASE_URL',
    'OPENVIE_APP_KIND',
    'OPENVIE_ENTITY',
    'POLL_INTERVAL_MS',
  ];
  const missing = required.filter((key) => !values[key]);
  if (missing.length) throw new ServiceError(`Missing .env values: ${missing.join(', ')}.`);
  if (!values.OPENVIE_API_KEY.startsWith('ovk_')) {
    throw new ServiceError('OPENVIE_API_KEY must be an ovk_ API key.');
  }
  try {
    new URL(values.OPENVIE_BASE_URL);
  } catch {
    throw new ServiceError('OPENVIE_BASE_URL must be a valid URL.');
  }
  const pollIntervalMs = Number(values.POLL_INTERVAL_MS);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new ServiceError('POLL_INTERVAL_MS must be a number of at least 1000.');
  }
  return {
    telegramToken: values.TELEGRAM_BOT_TOKEN,
    openVieApiKey: values.OPENVIE_API_KEY,
    openVieBaseUrl: values.OPENVIE_BASE_URL.replace(/\/+$/, ''),
    appKind: values.OPENVIE_APP_KIND,
    entity: values.OPENVIE_ENTITY,
    pollIntervalMs,
  };
}

async function readJson(fileName, fallback) {
  try {
    const raw = await readFile(fileName, 'utf8');
    await chmod(fileName, 0o600);
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new ServiceError(`Cannot read ${fileName}.`);
  }
}

async function writePrivateJson(fileName, value) {
  const temporaryFile = `${fileName}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryFile, 0o600);
  await rename(temporaryFile, fileName);
  await chmod(fileName, 0o600);
}

async function loadSubmissions() {
  const data = await readJson(SUBMISSIONS_FILE, {});
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new ServiceError('submissions.json must contain an object.');
  }
  return data;
}

async function loadChatSessions() {
  const data = await readJson(CHAT_SESSIONS_FILE, {});
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new ServiceError('chat-sessions.json must contain an object.');
  }
  return data;
}

async function loadOffset() {
  const data = await readJson(UPDATE_OFFSET_FILE, { offset: 0 });
  return Number.isSafeInteger(data?.offset) && data.offset >= 0 ? data.offset : 0;
}

function apiPath(config, recordId = '') {
  const base = `${config.openVieBaseUrl}/api/v1/bizapp-data/${encodeURIComponent(config.appKind)}/${encodeURIComponent(config.entity)}`;
  return recordId ? `${base}/${encodeURIComponent(recordId)}` : base;
}

function chatSessionPath(sessionId = '') {
  const base = '/api/v1/chat/sessions';
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

async function openVieRequest(config, method, url, body, extraHeaders = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.openVieApiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ServiceError('OpenVie request failed. Check network and OPENVIE_BASE_URL.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const error = await response.json();
      if (typeof error?.message === 'string' && error.message.trim()) {
        detail = ` ${error.message.trim()}`;
      }
    } catch {
      // Preserve the HTTP status when the server did not return a JSON error body.
    }
    throw new ServiceError(`OpenVie returned HTTP ${response.status}.${detail}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ServiceError('OpenVie returned invalid JSON.');
  }
}

async function telegramRequest(config, method, payload) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ServiceError('Telegram request failed. Check network and TELEGRAM_BOT_TOKEN.');
  }
  if (!response.ok) throw new ServiceError(`Telegram returned HTTP ${response.status}.`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ServiceError('Telegram returned invalid JSON.');
  }
  if (!data.ok) throw new ServiceError('Telegram rejected the request. Check TELEGRAM_BOT_TOKEN.');
  return data.result;
}

async function sendMessage(config, chatId, text, extra = {}) {
  return telegramRequest(config, 'sendMessage', { chat_id: chatId, text, ...extra });
}

function splitTelegramText(text) {
  const chunks = [];
  let remaining = String(text || '').trim() || 'OpenVie không trả về nội dung.';
  while (remaining.length > 4096) {
    const breakpoint = Math.max(remaining.lastIndexOf('\n', 4000), remaining.lastIndexOf(' ', 4000));
    const index = breakpoint > 0 ? breakpoint : 4096;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

async function sendLongMessage(config, chatId, text, extra = {}) {
  const chunks = splitTelegramText(text);
  const messages = [];
  for (let index = 0; index < chunks.length; index += 1) {
    messages.push(await sendMessage(config, chatId, chunks[index], index === chunks.length - 1 ? extra : {}));
  }
  return messages;
}

async function deleteTelegramMessages(config, chatId, messageIds = []) {
  const uniqueIds = [...new Set(messageIds.filter(Number.isSafeInteger))];
  for (const messageId of uniqueIds) {
    try {
      await telegramRequest(config, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (error) {
      console.warn(`Could not delete Telegram message ${messageId}: ${errorLabel(error)}`);
    }
  }
}

async function saveChatSessions(state) {
  await writePrivateJson(CHAT_SESSIONS_FILE, state.chatSessions);
}

async function getChatSession(config, state, chatId) {
  const key = String(chatId);
  const current = state.chatSessions[key];
  if (current?.sessionId) return current;

  const session = await openVieRequest(
    config,
    'POST',
    `${config.openVieBaseUrl}${chatSessionPath()}`,
    { locale: 'vi', metadata: { channel: 'telegram', telegram_chat_id: key } },
    { Accept: 'application/json' },
  );
  if (!session?.id) throw new ServiceError('OpenVie did not create a chat session.');
  state.chatSessions[key] = { sessionId: session.id, pendingActions: {} };
  await saveChatSessions(state);
  return state.chatSessions[key];
}

function recordIdFromAction(result) {
  const candidates = [
    result?.recordId,
    result?.record?.id,
    result?.action?.result?.recordId,
    result?.action?.result?.record?.id,
  ];
  return candidates.find((value) => typeof value === 'string' && value) ?? null;
}

function displayFieldValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(displayFieldValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function actionReview(action) {
  if (!action || typeof action !== 'object') return '';
  const fields = action.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    return '';
  }
  const labels = action.fieldLabels && typeof action.fieldLabels === 'object'
    ? action.fieldLabels
    : {};
  const entity = action.entityLabel || action.entity || 'yêu cầu';
  const rows = Object.entries(fields).map(([name, value]) =>
    `${labels[name] || name}: ${displayFieldValue(value)}`,
  );
  return [
    `Vui lòng kiểm tra lại thông tin ${entity}:`,
    '',
    ...rows,
    '',
    'Nếu thông tin chính xác, chọn Xác nhận gửi đơn.',
  ].join('\n');
}

async function relayOpenVieChat(config, state, chatId, text) {
  const chatSession = await getChatSession(config, state, chatId);
  const answer = await openVieRequest(
    config,
    'POST',
    `${config.openVieBaseUrl}${chatSessionPath(chatSession.sessionId)}/messages`,
    { content: text },
    { Accept: 'application/json' },
  );
  const action = answer?.action;
  let extra = {};
  if (
    action?.type === 'bizapp_action'
    && ['VALID', 'PROPOSED'].includes(action.status)
    && typeof action.actionId === 'string'
  ) {
    chatSession.pendingActions ??= {};
    chatSession.pendingActions[action.actionId] = { messageId: answer.id ?? null, createdAt: new Date().toISOString() };
    await saveChatSessions(state);
    extra = {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Xác nhận gửi đơn', callback_data: `openvie:execute:${action.actionId}` },
          { text: 'Sửa lại', callback_data: `openvie:edit:${action.actionId}` },
        ]],
      },
    };
  }
  const review = actionReview(action);
  const responseText = [answer?.content, review].filter(Boolean).join('\n\n');
  const messages = await sendLongMessage(config, chatId, responseText, extra);
  const pending = chatSession.pendingActions?.[action?.actionId];
  if (pending) {
    pending.telegramMessageIds = messages.map((message) => message?.message_id).filter(Number.isSafeInteger);
    await saveChatSessions(state);
  }
}

async function executeOpenVieAction(config, state, chatId, actionId) {
  const chatSession = state.chatSessions[String(chatId)];
  const pending = chatSession?.pendingActions?.[actionId];
  if (!pending) {
    await sendMessage(config, chatId, 'Yêu cầu này không còn hiệu lực. Hãy gửi lại thông tin cho OpenVie.');
    return;
  }
  if (pending.executing) {
    await sendMessage(config, chatId, 'Yêu cầu đang được gửi tới OpenVie.');
    return;
  }
  pending.executing = true;
  await saveChatSessions(state);
  let result;
  try {
    result = await openVieRequest(
      config,
      'POST',
      `${config.openVieBaseUrl}/api/v1/chat/actions/execute`,
      { actionId, ...(pending.messageId ? { messageId: pending.messageId } : {}) },
      { Accept: 'application/json' },
    );
  } catch (error) {
    delete pending.executing;
    await saveChatSessions(state);
    await sendMessage(config, chatId, `Không thể gửi đơn: ${errorLabel(error)} Vui lòng thử lại.`);
    return;
  }
  delete chatSession.pendingActions[actionId];
  await saveChatSessions(state);
  await deleteTelegramMessages(config, chatId, pending.telegramMessageIds);
  const recordId = recordIdFromAction(result);
  if (recordId) {
    state.submissions[recordId] = {
      chatId,
      processId: null,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      notifiedStatus: null,
    };
    await writePrivateJson(SUBMISSIONS_FILE, state.submissions);
  }
  await sendLongMessage(config, chatId, result?.content || 'Đã gửi yêu cầu tới OpenVie.');
}

async function reviseOpenVieAction(config, state, chatId, actionId) {
  const chatSession = state.chatSessions[String(chatId)];
  const pending = chatSession?.pendingActions?.[actionId];
  if (!pending) {
    await sendMessage(config, chatId, 'Yêu cầu này không còn hiệu lực. Hãy gửi lại thông tin cho OpenVie.');
    return;
  }
  await deleteTelegramMessages(config, chatId, pending.telegramMessageIds);
  delete chatSession.pendingActions[actionId];
  await saveChatSessions(state);
  await sendMessage(config, chatId, [
    'Hãy nhắn lại thông tin cần sửa, ví dụ: “đổi ngày bắt đầu thành 2026-11-20”.',
    'Mình sẽ gửi bản xem lại mới trước khi tạo đơn.',
  ].join('\n'));
}

function approvalStatus(record) {
  const status = record?.runtime?.approvalStatus;
  return ['APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING';
}

function approvalStatusLabel(status) {
  if (status === 'APPROVED') return 'ĐÃ DUYỆT';
  if (status === 'REJECTED') return 'ĐÃ TỪ CHỐI';
  return 'ĐANG CHỜ DUYỆT';
}

async function sendLeaveStatuses(config, state, chatId) {
  const submissions = Object.entries(state.submissions)
    .filter(([, submission]) => String(submission?.chatId) === String(chatId));
  if (submissions.length === 0) {
    await sendMessage(config, chatId, 'Bạn chưa có đơn nào được gửi từ cuộc trò chuyện này.');
    return;
  }

  const lines = ['Trạng thái đơn nghỉ:'];
  let changed = false;
  for (const [recordId, submission] of submissions) {
    let status = submission.status || 'PENDING';
    try {
      const record = await openVieRequest(config, 'GET', apiPath(config, recordId));
      status = approvalStatus(record);
      if (submission.status !== status) {
        submission.status = status;
        changed = true;
      }
    } catch (error) {
      console.error(`Could not load status for ${recordId}: ${errorLabel(error)}`);
    }
    lines.push(`Đơn #${recordId.slice(0, 8)}: ${approvalStatusLabel(status)}.`);
  }
  if (changed) await writePrivateJson(SUBMISSIONS_FILE, state.submissions);
  await sendMessage(config, chatId, lines.join('\n'));
}

async function handleMessage(config, state, message) {
  const chatId = message?.chat?.id;
  if (!chatId || typeof message.text !== 'string') return;
  const text = message.text.trim();
  const command = text.startsWith('/') ? text.split(/\s+/, 1)[0].split('@', 1)[0] : null;
  if (command === '/start') {
    await sendMessage(config, chatId, 'Chào bạn! Hãy nhắn tự nhiên như trên OpenVie, ví dụ: “Tôi muốn xin nghỉ”. Tôi sẽ chuyển hội thoại đến OpenVie và gửi lại câu trả lời tại đây. Dùng /new để bắt đầu cuộc trò chuyện mới hoặc /status để xem trạng thái đơn.');
    return;
  }
  if (command === '/new' || command === '/cancel') {
    delete state.chatSessions[String(chatId)];
    await saveChatSessions(state);
    await sendMessage(config, chatId, 'Đã bắt đầu cuộc trò chuyện mới với OpenVie.');
    return;
  }
  if (command === '/leave') {
    await relayOpenVieChat(config, state, chatId, 'Tôi muốn xin nghỉ');
    return;
  }
  if (command === '/status') {
    await sendLeaveStatuses(config, state, chatId);
    return;
  }
  if (command) {
    await sendMessage(config, chatId, 'Lệnh không hỗ trợ. Hãy nhắn nội dung bình thường, dùng /leave để bắt đầu, /status để xem trạng thái, hoặc /new để tạo cuộc trò chuyện mới.');
    return;
  }
  await relayOpenVieChat(config, state, chatId, text);
}

async function handleCallback(config, state, callback) {
  const chatId = callback?.message?.chat?.id;
  const data = callback?.data;
  if (!callback?.id || !chatId || typeof data !== 'string') return;
  await telegramRequest(config, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
  if (data.startsWith('openvie:execute:')) {
    await executeOpenVieAction(config, state, chatId, data.slice('openvie:execute:'.length));
    return;
  }
  if (data.startsWith('openvie:edit:')) {
    await reviseOpenVieAction(config, state, chatId, data.slice('openvie:edit:'.length));
    return;
  }
  await sendMessage(config, chatId, 'Nút này không còn hiệu lực. Hãy gửi lại thông tin cho OpenVie.');
}

async function pollSubmissionStatuses(config, state) {
  for (const [recordId, submission] of Object.entries(state.submissions)) {
    if (!submission?.chatId) continue;
    try {
      const record = await openVieRequest(config, 'GET', apiPath(config, recordId));
      const status = approvalStatus(record);
      submission.status = status;
      if (['APPROVED', 'REJECTED'].includes(status) && submission.notifiedStatus !== status) {
        await sendMessage(config, submission.chatId, `Đơn #${recordId.slice(0, 8)}: ${approvalStatusLabel(status)}.`);
        submission.notifiedStatus = status;
      }
      await writePrivateJson(SUBMISSIONS_FILE, state.submissions);
    } catch (error) {
      console.error(`Status poll for one submission failed: ${errorLabel(error)}`);
    }
  }
}

async function runTelegramLoop(config, state) {
  while (true) {
    try {
      const updates = await telegramRequest(config, 'getUpdates', {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const update of updates) {
        try {
          if (update.message) await handleMessage(config, state, update.message);
          if (update.callback_query) await handleCallback(config, state, update.callback_query);
        } catch (error) {
          console.error(`Telegram update failed: ${errorLabel(error)}`);
        } finally {
          // A malformed or failed update must not stop every later update from arriving.
          state.offset = update.update_id + 1;
          try {
            await writePrivateJson(UPDATE_OFFSET_FILE, { offset: state.offset });
          } catch (error) {
            console.error(`Could not save Telegram update offset: ${errorLabel(error)}`);
          }
        }
      }
    } catch (error) {
      console.error(`Telegram polling failed: ${errorLabel(error)}`);
      await sleep(5000);
    }
  }
}

async function runStatusLoop(config, state) {
  while (true) {
    await pollSubmissionStatuses(config, state).catch((error) => {
      console.error(`Status polling loop failed: ${errorLabel(error)}`);
    });
    await sleep(config.pollIntervalMs);
  }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new ServiceError('Node.js 22 or newer is required.');
  }
  const config = buildConfig(await readEnvFile());
  const state = {
    submissions: await loadSubmissions(),
    chatSessions: await loadChatSessions(),
    offset: await loadOffset(),
  };
  console.info('Telegram leave bot started.');
  await Promise.all([runTelegramLoop(config, state), runStatusLoop(config, state)]);
}

main().catch((error) => {
  console.error(`Bot could not start: ${errorLabel(error)}`);
  process.exitCode = 1;
});
