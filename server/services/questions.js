import crypto from 'node:crypto';

export const ASK_QUESTION_SCHEMA = {
  type: 'function',
  function: {
    name: 'ask_question',
    description: 'Ask the user one or more clarifying questions (with optional multiple-choice options) and wait for their answer before continuing your response.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask the user.',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question text to present to the user.'
              },
              header: {
                type: 'string',
                description: 'Optional short category or header for this question (e.g. "Database", "Style", "Scope").'
              },
              options: {
                type: 'array',
                description: 'Optional choices for the user to choose from. Can be strings or {label, description} objects.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Label/title of the option' },
                    description: { type: 'string', description: 'Explanation or detail of the option' }
                  },
                  required: ['label']
                }
              },
              multiSelect: {
                type: 'boolean',
                description: 'Whether the user can select multiple options (default false).'
              },
              is_multi_select: {
                type: 'boolean',
                description: 'Whether the user can select multiple options.'
              }
            },
            required: ['question']
          }
        }
      },
      required: ['questions']
    }
  }
};

export const ASK_USER_QUESTION_SCHEMA = {
  type: 'function',
  function: {
    ...ASK_QUESTION_SCHEMA.function,
    name: 'AskUserQuestion'
  }
};

export function getInteractiveTools() {
  return [
    {
      name: 'ask_question',
      qualifiedName: 'ask_question',
      description: ASK_QUESTION_SCHEMA.function.description,
      isInteractiveQuestion: true,
      approval: 'never',
      annotations: { readOnlyHint: true },
      schema: ASK_QUESTION_SCHEMA
    },
    {
      name: 'AskUserQuestion',
      qualifiedName: 'AskUserQuestion',
      description: ASK_USER_QUESTION_SCHEMA.function.description,
      isInteractiveQuestion: true,
      approval: 'never',
      annotations: { readOnlyHint: true },
      schema: ASK_USER_QUESTION_SCHEMA
    }
  ];
}

export function normalizeQuestions(args) {
  if (!args) return [];
  let list = [];
  if (Array.isArray(args.questions)) {
    list = args.questions;
  } else if (typeof args.question === 'string') {
    list = [{
      question: args.question,
      header: args.header,
      options: args.options,
      multiSelect: args.multiSelect ?? args.is_multi_select
    }];
  } else if (typeof args.questions === 'string') {
    list = [{ question: args.questions }];
  } else if (Array.isArray(args)) {
    list = args;
  }

  const normalized = list.map((item, idx) => {
    if (typeof item === 'string') {
      return { id: `q_${idx}`, question: item, options: [], multiSelect: false };
    }
    const qText = item?.question || item?.title || item?.header || `Question ${idx + 1}`;
    const header = item?.header || null;
    const multi = !!(item?.multiSelect || item?.is_multi_select);
    let options = [];
    if (Array.isArray(item?.options)) {
      options = item.options.map((opt) => {
        if (typeof opt === 'string') return { label: opt, description: '' };
        return {
          label: String(opt?.label ?? opt?.text ?? opt?.title ?? opt?.value ?? '').trim(),
          description: String(opt?.description ?? '').trim()
        };
      }).filter((o) => o.label.length > 0);
    }
    return {
      id: item?.id || `q_${idx}`,
      question: qText,
      header,
      options,
      multiSelect: multi
    };
  });

  return normalized.length ? normalized : [{ id: 'q_0', question: 'Please clarify your requirements or preferences.', options: [], multiSelect: false }];
}

const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;
const KEEPALIVE_MS = 15 * 1000;
const pendingQuestions = new Map(); // id -> entry
const subscribers = new Map(); // SSE response -> userId

export function subscribeQuestions(res, userId) {
  subscribers.set(res, userId);
  for (const entry of pendingQuestions.values()) {
    if (userId != null && entry.userId !== userId) continue;
    res.write(`event: question_prompt\ndata: ${JSON.stringify(entry.meta)}\n\n`);
  }
  return () => subscribers.delete(res);
}

function broadcast(event, data, userId) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, uid] of [...subscribers]) {
    if (userId != null && uid !== userId) continue;
    if (res.writableEnded) {
      subscribers.delete(res);
      continue;
    }
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
}

export function requestQuestion({ send, userId, conversationId, toolCallId, questions, signal }) {
  const id = crypto.randomBytes(8).toString('hex');
  const meta = {
    id,
    conversationId: Number(conversationId),
    toolCallId: String(toolCallId),
    questions,
    requestedAt: Date.now()
  };

  const emit = (event, data) => {
    if (send) send(event, data);
    broadcast(event, data, userId);
  };

  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(entry.timer);
      clearInterval(entry.keepalive);
      pendingQuestions.delete(id);
      emit('question_resolved', {
        id,
        conversationId: meta.conversationId,
        toolCallId: meta.toolCallId,
        cancelled: !!result.cancelled,
        answers: result.answers || []
      });
      resolve(result);
    };

    const entry = {
      id,
      userId,
      conversationId: meta.conversationId,
      toolCallId: meta.toolCallId,
      meta,
      resolve: finish,
      timer: setTimeout(() => finish({ cancelled: true, reason: 'Timed out waiting for answer (15 minutes).' }), QUESTION_TIMEOUT_MS),
      keepalive: setInterval(() => emit('keepalive', { id }), KEEPALIVE_MS)
    };
    pendingQuestions.set(id, entry);

    if (signal) {
      if (signal.aborted) {
        finish({ cancelled: true, reason: 'The chat turn was cancelled.' });
        return;
      }
      signal.addEventListener('abort', () => {
        if (pendingQuestions.has(id)) finish({ cancelled: true, reason: 'The chat turn was cancelled.' });
      }, { once: true });
    }

    emit('question_prompt', meta);
  });
}

export function resolveQuestion(id, { answers }, userId) {
  const entry = pendingQuestions.get(id) || [...pendingQuestions.values()].find((p) => p.toolCallId === id || p.id === id);
  if (!entry) return false;
  if (userId != null && entry.userId != null && entry.userId !== userId) return false;
  entry.resolve({
    cancelled: false,
    answers: Array.isArray(answers) ? answers : (answers ? [answers] : [])
  });
  return true;
}

export function cancelQuestion(id, reason, userId) {
  const entry = pendingQuestions.get(id) || [...pendingQuestions.values()].find((p) => p.toolCallId === id || p.id === id);
  if (!entry) return false;
  if (userId != null && entry.userId != null && entry.userId !== userId) return false;
  entry.resolve({
    cancelled: true,
    reason: reason || 'Cancelled by the user.'
  });
  return true;
}

export function listPendingQuestions(userId, conversationId) {
  const convId = conversationId != null ? Number(conversationId) : null;
  return [...pendingQuestions.values()]
    .filter((p) => {
      if (userId != null && p.userId != null && p.userId !== userId) return false;
      if (convId != null && p.conversationId !== convId) return false;
      return true;
    })
    .map((p) => p.meta);
}

export function formatQuestionResult(result) {
  if (result.cancelled) {
    return result.reason || 'The user cancelled or skipped answering the question. Continue your response without the answer.';
  }
  const answers = result.answers || [];
  if (!answers.length) {
    return 'User submitted an empty answer.';
  }
  const lines = ['User answered the question(s):'];
  for (const a of answers) {
    const qTitle = a.question || a.header || 'Question';
    let ansVal = '';
    if (Array.isArray(a.selectedOptions) && a.selectedOptions.length) {
      ansVal = a.selectedOptions.join(', ');
    } else if (a.answer != null) {
      ansVal = Array.isArray(a.answer) ? a.answer.join(', ') : String(a.answer);
    } else if (a.value != null) {
      ansVal = Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
    }
    if (a.customText && a.customText.trim()) {
      ansVal = ansVal ? `${ansVal} (Note: ${a.customText.trim()})` : a.customText.trim();
    }
    if (!ansVal) ansVal = 'No selection made';
    lines.push(`- ${qTitle}: ${ansVal}`);
  }
  return lines.join('\n');
}

export async function handleQuestionTool({ args, toolCallId, conversationId, userId, send, signal }) {
  const questions = normalizeQuestions(args);
  const result = await requestQuestion({
    send,
    userId,
    conversationId,
    toolCallId,
    questions,
    signal
  });
  return {
    text: formatQuestionResult(result),
    cancelled: !!result.cancelled
  };
}

