/**
 * Tests for interactive ask_question / AskUserQuestion functionality:
 * 1. Tools presence when MCP is disabled (use_tools: false).
 * 2. Tools presence when MCP is enabled (use_tools: true).
 * 3. Question prompt flow: ask_question -> question_prompt SSE -> answer -> resume.
 * 4. Question prompt flow with AskUserQuestion alias.
 * 5. Fallback parsing for raw <tool_call> tags in assistant content.
 * 6. Cancellation / skip flow.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4780;
const MOCK_PORT = 4781;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-q-check-'));
const dbPath = path.join(tmp, 'test.db');
const workDir = path.join(tmp, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? `\n      ${String(extra).split('\n').join('\n      ')}` : ''}`);
  }
}

let lastReceivedTools = null;
let mockScenario = 'normal';

// Custom mock OpenAI server
const mockServer = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      lastReceivedTools = parsed.tools || [];
      const msgs = parsed.messages || [];
      const lastMsg = msgs[msgs.length - 1];

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const sendChunk = (delta) => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      };

      if (lastMsg.role === 'tool') {
        // Model responds after tool result
        sendChunk({ content: `Received your answer: ${lastMsg.content}. Proceeding!` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (mockScenario === 'ask_question_call') {
        // Model emits tool call for ask_question
        const callId = 'call_q_123';
        const toolArgs = JSON.stringify({
          questions: [
            {
              header: 'Preferences',
              question: 'Which framework do you prefer?',
              options: [
                { label: 'Vanilla JS', description: 'Zero build step' },
                { label: 'React', description: 'Component based' }
              ],
              multiSelect: false
            }
          ]
        });
        sendChunk({
          tool_calls: [
            {
              id: callId,
              index: 0,
              type: 'function',
              function: { name: 'ask_question', arguments: toolArgs }
            }
          ]
        });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (mockScenario === 'ask_user_question_alias') {
        // Model calls AskUserQuestion (Qwen-style alias)
        const callId = 'call_q_456';
        const toolArgs = JSON.stringify({
          questions: [
            {
              question: 'Pick your favorites',
              options: ['Option A', 'Option B'],
              is_multi_select: true
            }
          ]
        });
        sendChunk({
          tool_calls: [
            {
              id: callId,
              index: 0,
              type: 'function',
              function: { name: 'AskUserQuestion', arguments: toolArgs }
            }
          ]
        });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (mockScenario === 'raw_tool_call_text') {
        // Model emits raw XML <tool_call> in content
        const raw = `<tool_call>\n<function=AskUserQuestion>\n<parameter=questions>\n[{"question": "What is your project name?", "options": []}]\n</parameter>\n</function>\n</tool_call>`;
        sendChunk({ content: raw });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // Default response
      sendChunk({ content: 'Hello! I am ready.' });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  return child;
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve));

  const appChild = start('app', ['server/index.js'], {
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    AUTH_DISABLED: '1',
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OPENAI_MODEL: 'mock-model'
  });

  const up = await waitFor(async () => {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok;
  }, 12000);

  if (!up) throw new Error('App server failed to start');
  console.log('App and mock server running. Testing interactive questions...\n');

  // Create test conversation
  const convRes = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Question Test', workdir: workDir })
  });
  const conv = await convRes.json();
  const convId = conv.id;

  // 1. Test MCP disabled: tools sent to model MUST include ask_question and AskUserQuestion
  mockScenario = 'normal';
  lastReceivedTools = null;
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Test mcp off', use_tools: false })
  });
  await waitFor(() => lastReceivedTools !== null, 5000);

  const toolNames = lastReceivedTools.map((t) => t.function?.name);
  check('ask_question present when MCP is disabled', toolNames.includes('ask_question'));
  check('AskUserQuestion present when MCP is disabled', toolNames.includes('AskUserQuestion'));
  check('Files/shell MCP tools NOT present when MCP is disabled', !toolNames.some((n) => n.startsWith('files__') || n.startsWith('shell__')));

  // 2. Test MCP enabled: both MCP tools and question tools present
  lastReceivedTools = null;
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Test mcp on', use_tools: true })
  });
  await waitFor(() => lastReceivedTools !== null, 5000);
  const toolNamesOn = lastReceivedTools.map((t) => t.function?.name);
  check('ask_question present when MCP is enabled', toolNamesOn.includes('ask_question'));
  check('Files MCP tools present when MCP is enabled', toolNamesOn.some((n) => n.startsWith('files__')));

  // 3. Test interactive question flow with ask_question
  mockScenario = 'ask_question_call';
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Which framework?', use_tools: false })
  });

  // Wait for pending question to appear
  let pendingData = null;
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/questions/pending?conversation_id=${convId}`);
    const j = await res.json();
    if (j.questions && j.questions.length > 0) {
      pendingData = j.questions[0];
      return true;
    }
    return false;
  }, 5000);

  check('Pending question registered on server', !!pendingData);
  check('Question text correctly received', pendingData?.questions?.[0]?.question === 'Which framework do you prefer?');
  check('Question options normalized correctly', pendingData?.questions?.[0]?.options?.length === 2);

  // Submit answer
  const answerRes = await fetch(`${BASE}/api/questions/${pendingData.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [
        {
          id: pendingData.questions[0].id,
          question: pendingData.questions[0].question,
          answer: 'Vanilla JS'
        }
      ]
    })
  });
  check('Answer accepted with ok: true', (await answerRes.json()).ok === true);

  // Wait for conversation turn to complete with resumed answer
  let lastMessage = null;
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/conversations/${convId}`);
    const j = await res.json();
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && last.content.includes('Received your answer:')) {
      lastMessage = last;
      return true;
    }
    return false;
  }, 8000);

  check('Assistant completed turn after answer', !!lastMessage);
  check('Assistant output mentions received answer', lastMessage?.content?.includes('Vanilla JS'));

  // 4. Test AskUserQuestion alias
  mockScenario = 'ask_user_question_alias';
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Choose favorites', use_tools: false })
  });

  let pendingAlias = null;
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/questions/pending?conversation_id=${convId}`);
    const j = await res.json();
    if (j.questions && j.questions.length > 0) {
      pendingAlias = j.questions[0];
      return true;
    }
    return false;
  }, 5000);

  check('AskUserQuestion alias registered pending question', !!pendingAlias);
  await fetch(`${BASE}/api/questions/${pendingAlias.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [{ id: 'q_0', question: 'Pick your favorites', answer: 'Option A, Option B' }]
    })
  });

  let aliasLastMessage = null;
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/conversations/${convId}`);
    const j = await res.json();
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && last.content.includes('Option A, Option B')) {
      aliasLastMessage = last;
      return true;
    }
    return false;
  }, 8000);
  check('Assistant resumed after answering AskUserQuestion alias', !!aliasLastMessage);

  // 5. Test raw <tool_call> fallback extraction in content
  mockScenario = 'raw_tool_call_text';
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Test raw tag', use_tools: false })
  });

  let pendingRaw = null;
  await waitFor(async () => {
    const res = await fetch(`${BASE}/api/questions/pending?conversation_id=${convId}`);
    const j = await res.json();
    if (j.questions && j.questions.length > 0) {
      pendingRaw = j.questions[0];
      return true;
    }
    return false;
  }, 5000);

  check('Raw <tool_call> text tag extracted into pending question', !!pendingRaw);
  check('Raw tag question extracted', pendingRaw?.questions?.[0]?.question === 'What is your project name?');

  // 6. Test cancellation / skip
  const cancelRes = await fetch(`${BASE}/api/questions/${pendingRaw.id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Skipped by user' })
  });
  check('Question successfully cancelled with ok: true', (await cancelRes.json()).ok === true);

} catch (err) {
  console.error('Test error:', err);
  failed++;
} finally {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
process.exit(failed > 0 ? 1 : 0);

