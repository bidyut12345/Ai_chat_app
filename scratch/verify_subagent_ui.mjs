import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBrowser, newTab, closeTab, evaluate, withPage, stopBrowsers } from '../server/services/builtin/cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4995;
const MOCK_PORT = 4996;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-ui-verify-'));
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
    console.error(`  ✗ ${label}${extra ? `\n      ${String(extra).split('\n').join('\n      ')}` : ''}`);
  }
}

let mockTurn = 0;
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
      const msgs = parsed.messages || [];
      const isSubagent = msgs.some((m) => m.role === 'system' && m.content?.includes('autonomous sub-agent'));

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      if (isSubagent) {
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        if (!hasToolResult) {
          const tcId = `call_sub_${Date.now()}`;
          const chunk = {
            id: 'mock-sub-1',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: tcId,
                  type: 'function',
                  function: {
                    name: 'files__write_file',
                    arguments: JSON.stringify({ path: 'config_audit.txt', content: 'Audit complete: all valid.' })
                  }
                }]
              }
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        } else {
          const chunk = {
            id: 'mock-sub-2',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                content: 'I audited the codebase configuration and successfully recorded audit details in config_audit.txt.'
              }
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      }

      mockTurn++;
      if (mockTurn === 1) {
        // Plan tasks
        const tcId = `call_plan_${Date.now()}`;
        const chunk = {
          id: 'mock-main-1',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: tcId,
                type: 'function',
                function: {
                  name: 'subagent__plan_tasks',
                  arguments: JSON.stringify({
                    tasks: [
                      { id: 'step_1', title: 'Audit codebase configuration', description: 'Analyze files and generate report' },
                      { id: 'step_2', title: 'Implement authentication fix', description: 'Apply patch to policy middleware' },
                      { id: 'step_3', title: 'Run test suite and verify', description: 'Execute automated regression tests' }
                    ]
                  })
                }
              }]
            }
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      } else if (mockTurn === 2) {
        // Run Step 1
        const tcId = `call_run_sub_${Date.now()}`;
        const chunk = {
          id: 'mock-main-2',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: tcId,
                type: 'function',
                function: {
                  name: 'subagent__run_task',
                  arguments: JSON.stringify({
                    title: 'Audit codebase configuration',
                    task: 'Audit files and write config_audit.txt',
                    workspace: 'audit_dir',
                    tools: ['files']
                  })
                }
              }]
            }
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      } else {
        const chunk = {
          id: 'mock-main-3',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              content: 'Step 1 audit completed. Now ready for subsequent steps.'
            }
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    });
  }
});

await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

const appEnv = {
  PORT: String(APP_PORT),
  DB_PATH: dbPath,
  AUTH_DISABLED: '1',
  OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  OPENAI_MODEL: 'mock-model'
};

const appProcess = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, ...appEnv },
  stdio: ['ignore', 'pipe', 'pipe']
});

appProcess.stderr.on('data', (d) => process.env.VERBOSE && console.error(`[app:err] ${d}`));

// Wait for app ready
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${BASE}/health`);
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

try {
  // Create conversation and execute turn
  const convRes = await fetch(`${BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Task Breakdown UI Test', workdir: workDir, approval_mode: 'auto' })
  });
  const conv = await convRes.json();
  const convId = conv.id;

  // Send message
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'Please plan and execute audit' })
  });

  // Consume SSE stream until done
  const sseRes = await fetch(`${BASE}/api/chat/stream?conversation_id=${convId}`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes('event: done')) break;
  }

  // Now launch headless Chrome and test the rendered UI
  console.log('\nLaunching headless Chrome to verify Task Breakdown & Subagent UI...');
  const browser = await ensureBrowser('chrome', { headless: true, port: 9222 });
  const tab = await newTab(9222, `${BASE}/?c=${convId}`);
  const pageId = tab.id;

  // Wait 2.5s for DOM render
  await new Promise((r) => setTimeout(r, 2500));

  // Evaluate UI assertions
  const evalResult = await withPage(9222, pageId, async (session) => {
    const res = await evaluate(session, `(() => {
      const cards = document.querySelectorAll('.task-roadmap-card');
      const items = document.querySelectorAll('.trc-step-item');
      const progressBar = document.querySelector('.trc-progress-bar');
      const progressFill = document.querySelector('.trc-progress-fill');
      const progressText = document.querySelector('.trc-progress-text');
      const filesEdited = document.querySelector('.trc-files-edited');
      const summaryBox = document.querySelector('.trc-summary-box');
      const subagentCard = document.querySelectorAll('.subagent-card');

      return {
        cardCount: cards.length,
        subagentCardCount: subagentCard.length,
        itemCount: items.length,
        hasProgressBar: !!progressBar,
        progressFillWidth: progressFill ? progressFill.style.width : '',
        progressText: progressText ? progressText.textContent : '',
        step1Open: items[0] ? items[0].hasAttribute('open') : false,
        step1Status: items[0] ? items[0].querySelector('.trc-step-status')?.textContent : '',
        hasFilesEdited: filesEdited && !filesEdited.classList.contains('hidden'),
        filesEditedText: filesEdited ? filesEdited.textContent : '',
        hasSummaryBox: summaryBox && !summaryBox.classList.contains('hidden'),
        summaryBoxText: summaryBox ? summaryBox.textContent : ''
      };
    })()`);

    fs.mkdirSync('scratch', { recursive: true });
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('scratch/task-roadmap-pill.png', Buffer.from(shot.data, 'base64'));

    return res;
  });

  console.log('UI evaluation result:', evalResult);

  check('Exactly ONE task list pill is rendered', evalResult.cardCount === 1);
  check('No redundant outer subagent-card pills rendered', evalResult.subagentCardCount === 0);
  check('Task breakdown contains all 3 steps', evalResult.itemCount === 3);
  check('Bottom progress bar exists', evalResult.hasProgressBar);
  check('Progress fill reflects completion', evalResult.progressFillWidth === '33%');
  check('Progress text indicates step completion', evalResult.progressText.includes('1 of 3 completed (33%)'));
  check('Step 1 status is Done', evalResult.step1Status.includes('✓ done'));
  check('Files Edited section is visible and contains edited file', evalResult.hasFilesEdited && evalResult.filesEditedText.includes('config_audit.txt'));
  check('Summary of Work Done is visible', evalResult.hasSummaryBox && evalResult.summaryBoxText.includes('Summary of Work Done:'));

  console.log('Screenshot saved to scratch/task-roadmap-pill.png');

  await closeTab(9222, pageId);
} finally {
  appProcess.kill();
  mockServer.close();
  try { stopBrowsers(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\nUI Verification results: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
