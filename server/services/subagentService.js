/**
 * Sub-Agent Execution Service.
 *
 * Runs an autonomous sub-agent on an isolated task:
 * - Scopes file and shell execution to the sub-agent's specified workspace.
 * - Restricts available tools to the requested set (preventing recursive subagents).
 * - Streams live reasoning and child tool calls over SSE for full observability.
 * - Consumes live user steering directives mid-flight.
 * - Concludes with a concise summary handed back to the orchestrator agent.
 */
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db.js';
import { chatCompletion, consumeChatStream, mcpToolsToOpenAi } from './openai.js';
import { allTools, callTool } from './mcpManager.js';
import { runWithPolicy, normalizePolicy, fileRoot, resolvePath, toolNeedsApproval } from './builtin/policy.js';
import { runWithFileChanges } from './fileChanges.js';
import { isPreApproved, requestApproval } from './approvals.js';

const MAX_SUBAGENT_ROUNDS = 12;

const SERVER_ALIASES = {
  file: 'files',
  files: 'files',
  fs: 'files',
  filesystem: 'files',
  shell: 'shell',
  terminal: 'shell',
  bash: 'shell',
  cmd: 'shell',
  powershell: 'shell',
  command: 'shell',
  cli: 'shell',
  exec: 'shell',
  sh: 'shell',
  windows: 'windows',
  win: 'windows',
  win32: 'windows',
  chrome: 'chrome',
  browser: 'chrome',
  edge: 'edge',
  background: 'background',
  tasks: 'background'
};

/**
 * Filter available conversation tools down to the requested list,
 * while strictly banning recursive subagent tool calls.
 */
function filterSubagentTools(conversation, allowedTools) {
  // Use all registered tools as candidates so delegating files/shell works
  // even if the orchestrator chat has them switched off for the main agent
  const all = allTools();
  // Ban subagent tools to avoid recursion
  const nonSubagent = all.filter((t) => {
    const qName = t.qualifiedName || t.name;
    return !qName.startsWith('subagent__');
  });

  if (!Array.isArray(allowedTools) || !allowedTools.length || allowedTools.includes('all') || allowedTools.includes('*')) {
    return nonSubagent;
  }

  const allowedServers = new Set();
  const allowedExact = new Set();

  for (const item of allowedTools) {
    const s = String(item).toLowerCase().trim();
    if (!s) continue;
    if (s === 'all' || s === '*') return nonSubagent;

    if (SERVER_ALIASES[s]) {
      allowedServers.add(SERVER_ALIASES[s]);
    }
    for (const [alias, canonical] of Object.entries(SERVER_ALIASES)) {
      if (s.includes(alias)) {
        allowedServers.add(canonical);
      }
    }
    allowedExact.add(s);
  }

  let filtered = nonSubagent.filter((t) => {
    const qName = (t.qualifiedName || t.name).toLowerCase();
    const serverName = (t.serverName || (t.qualifiedName || t.name).split('__')[0] || '').toLowerCase();
    const bareName = (t.name || '').toLowerCase();

    return allowedExact.has(qName) || allowedExact.has(bareName) || allowedServers.has(serverName);
  });

  if (!filtered.length) {
    // If nothing matched the alias keywords, fall back to safe standard tools
    filtered = nonSubagent.filter((t) => {
      const serverName = (t.serverName || (t.qualifiedName || t.name).split('__')[0] || '').toLowerCase();
      return serverName === 'files' || serverName === 'shell';
    });
    if (!filtered.length) filtered = nonSubagent;
  }

  return filtered;
}

/**
 * Run one autonomous subagent task.
 */
export async function executeSubagentTask({
  conversation,
  cfg,
  callId,
  title,
  task,
  context,
  workspace,
  tools: requestedTools,
  max_rounds = 8,
  emit = () => {},
  signal,
  callSignal,
  runObj
}) {
  const startedAt = Date.now();
  const subagentTitle = String(title || task?.slice(0, 40) || 'Sub-agent task').trim();

  // Resolve target workspace
  let targetWorkdir = conversation.workdir || fileRoot() || process.cwd();
  if (workspace && typeof workspace === 'string' && workspace.trim()) {
    try {
      targetWorkdir = resolvePath(workspace.trim(), { mustExist: false });
    } catch {
      targetWorkdir = path.resolve(targetWorkdir, workspace.trim());
    }
  }

  // Ensure workspace directory exists if possible
  try {
    if (!fs.existsSync(targetWorkdir)) {
      fs.mkdirSync(targetWorkdir, { recursive: true });
    }
  } catch {}

  // Tool filtering
  const availableTools = filterSubagentTools(conversation, requestedTools);
  const toolSchemas = availableTools.length ? mcpToolsToOpenAi(availableTools) : undefined;
  const toolIndex = new Map(availableTools.map((t) => [t.qualifiedName || t.name, t]));

  // Notify UI of subagent start
  emit('subagent_start', {
    call_id: callId,
    title: subagentTitle,
    task,
    workspace: targetWorkdir,
    tools: availableTools.map((t) => t.qualifiedName || t.name)
  });

  // Determine which servers are granted to the subagent
  const grantedServers = new Set(
    availableTools.map((t) => (t.serverName || (t.qualifiedName || t.name).split('__')[0] || '').toLowerCase())
  );
  let convDisabled = [];
  try {
    convDisabled = conversation.mcp_disabled ? JSON.parse(conversation.mcp_disabled) : [];
  } catch {}
  const effectiveDisabled = new Set(Array.isArray(convDisabled) ? convDisabled : []);
  for (const s of grantedServers) {
    effectiveDisabled.delete(s);
  }

  // Effective policy for this subagent execution: scope to workspace and enable granted tools
  const effectivePolicy = normalizePolicy({
    ...conversation,
    workdir: targetWorkdir,
    files_enabled: grantedServers.has('files') ? 1 : conversation.files_enabled,
    shell_enabled: grantedServers.has('shell') ? 1 : conversation.shell_enabled,
    mcp_disabled: JSON.stringify([...effectiveDisabled])
  });

  // Compose subagent system prompt
  const toolNamesStr = availableTools.map((t) => t.qualifiedName || t.name).join(', ') || 'none';
  const sysPrompt = [
    `You are an autonomous sub-agent performing a specific task for the main orchestrator agent.`,
    `Task Goal: ${task}`,
    `Working Directory: ${targetWorkdir}`,
    `Available Tools: ${toolNamesStr}`,
    `Guidelines:`,
    `- Execute the task diligently and step-by-step using your available tools.`,
    `- All file and command operations must remain inside or relevant to: ${targetWorkdir}.`,
    `- Respond ONLY to the assigned task.`,
    `- When finished, you MUST provide a detailed commentary and summary of what was accomplished: include specific actions taken, files modified/created, tests run, and final outcomes. Do not finish with an empty summary!`,
    `- Keep the summary structured and easy for the main agent to interpret.`
  ].join('\n\n');

  const messages = [
    { role: 'system', content: sysPrompt },
    {
      role: 'user',
      content: context
        ? `Task: ${task}\n\nContext & Background:\n${context}`
        : `Task: ${task}`
    }
  ];

  const maxRounds = Math.min(MAX_SUBAGENT_ROUNDS, Math.max(1, Number(max_rounds) || 8));
  let finalSummary = '';
  const toolsUsed = [];
  const filesModified = [];

  // Combine abort signals
  const isAborted = () => signal?.aborted || callSignal?.aborted;

  return runWithPolicy(effectivePolicy, async () => {
    return runWithFileChanges({ conversationId: conversation.id, messageId: runObj?.turnMessageId }, async () => {
      try {
        for (let round = 0; round < maxRounds; round++) {
          if (isAborted()) {
            throw new Error('Sub-agent task was cancelled.');
          }

          // Check if any steering directives arrived from the user
          if (runObj && Array.isArray(runObj.steeringQueue) && runObj.steeringQueue.length) {
            const steerList = [...runObj.steeringQueue];
            runObj.steeringQueue.length = 0; // consume
            for (const item of steerList) {
              const text = item.content || item;
              messages.push({
                role: 'user',
                content: `[User Steering Guidance during sub-agent run]: ${text}`
              });
              emit('steer_applied', { call_id: callId, target: 'subagent', content: text });
            }
          }

          const reqBody = {
            messages,
            stream: true,
            temperature: cfg.temperature ?? 0.2
          };
          if (toolSchemas) reqBody.tools = toolSchemas;

          const roundSignal = AbortSignal.any(
            [callSignal || signal, AbortSignal.timeout(120000)].filter(Boolean)
          );

          const upstream = await chatCompletion(cfg, reqBody, {
            stream: true,
            signal: roundSignal
          });

          let roundText = '';
          let roundReasoning = '';
          const assistant = await consumeChatStream(
            upstream,
            (chunk) => {
              roundText += chunk;
              emit('subagent_thought', { call_id: callId, text: chunk });
            },
            (chunk) => {
              roundReasoning += chunk;
              emit('subagent_thought', { call_id: callId, text: chunk });
            },
            ({ id, name, argsDelta }) => {
              emit('subagent_tool_generating', { call_id: callId, tool_call_id: id, name, argsDelta });
            }
          );

          const hasTools = Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0;

          if (!hasTools) {
            finalSummary = assistant.content || roundText || '';
            break;
          }

          // Persist assistant message with tool calls in sub-agent memory
          messages.push({
            role: 'assistant',
            content: assistant.content || '',
            tool_calls: assistant.tool_calls
          });

          // Execute subagent tool calls
          for (const tc of assistant.tool_calls) {
            if (isAborted()) throw new Error('Sub-agent task was cancelled.');

            const name = tc.function.name;
            let args = {};
            try {
              args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {}

            const toolStart = Date.now();
            emit('subagent_tool_call', {
              call_id: callId,
              tool_call_id: tc.id,
              name,
              arguments: args
            });

            let resultText = '';
            let toolFailed = false;

            try {
              if (!toolIndex.has(name)) {
                resultText = `Tool error: Tool "${name}" is not granted to this sub-agent.`;
                toolFailed = true;
              } else {
                const tool = toolIndex.get(name);
                // Policy / approval gate
                if (toolNeedsApproval(tool) && !isPreApproved(conversation.user_id, conversation.id, name)) {
                  const answer = await requestApproval({
                    send: (event, data) => emit(event, data),
                    userId: conversation.user_id,
                    conversationId: conversation.id,
                    qualifiedName: name,
                    args,
                    signal: callSignal || signal
                  });
                  if (!answer.allowed) {
                    resultText = `Tool denied: ${answer.reason || 'User rejected the action'}`;
                    toolFailed = true;
                  }
                }

                if (!toolFailed) {
                  resultText = await callTool(name, args, undefined, callSignal || signal);
                  toolsUsed.push(name);
                  // Record modified files
                  const mutatingTools = new Set([
                    'files__write_file',
                    'files__edit_file',
                    'files__append_file',
                    'files__delete',
                    'files__copy_path',
                    'files__move_path',
                    'files__create_directory',
                    'files__zip',
                    'files__unzip',
                    'files__share_workspace'
                  ]);
                  if (mutatingTools.has(name)) {
                    const p = args?.path || args?.to || args?.target || args?.target_dir || (name === 'files__share_workspace' ? 'workspace.zip' : null);
                    if (p) filesModified.push(String(p));
                  }
                }
              }
            } catch (err) {
              resultText = `Tool error: ${err.message || err}`;
            }

            const toolDuration = Date.now() - toolStart;
            emit('subagent_tool_result', {
              call_id: callId,
              tool_call_id: tc.id,
              name,
              result: resultText,
              duration_ms: toolDuration
            });

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: String(resultText || '')
            });
          }
        }
      } catch (err) {
        if (isAborted()) {
          finalSummary = `Sub-agent task was cancelled by user.`;
        } else {
          finalSummary = `Sub-agent encountered an error: ${err.message || err}`;
        }
      }

      // Check DB file_changes for any edits recorded during this turn
      if (runObj?.turnMessageId) {
        try {
          const rows = db.prepare('SELECT path, rel_path FROM file_changes WHERE message_id = ?').all(runObj.turnMessageId);
          for (const r of rows) {
            if (r.rel_path) filesModified.push(r.rel_path);
            else if (r.path) filesModified.push(r.path);
          }
        } catch {}
      }

      // If summary is missing or lacked detailed commentary, request a synthesis round
      if (!isAborted() && (!finalSummary || finalSummary.trim().length < 25 || finalSummary.toLowerCase().includes('without detailed commentary'))) {
        try {
          const summaryPromptMessages = [
            ...messages,
            {
              role: 'user',
              content: 'Please provide a clear and detailed summary of what was completed: describe the specific actions taken, the files modified or created, and the final outcome of this task.'
            }
          ];
          const summarySignal = AbortSignal.any(
            [callSignal || signal, AbortSignal.timeout(30000)].filter(Boolean)
          );
          const summaryUpstream = await chatCompletion(cfg, {
            messages: summaryPromptMessages,
            stream: false,
            temperature: 0.2
          }, { signal: summarySignal });
          const candidateText = summaryUpstream?.choices?.[0]?.message?.content?.trim();
          if (candidateText && candidateText.length > 10) {
            finalSummary = candidateText;
          }
        } catch {
          /* fallback to synthesized report below */
        }
      }

      const filesList = [...new Set(filesModified)];
      const toolsList = [...new Set(toolsUsed)];

      if (!finalSummary || finalSummary.trim().length < 10) {
        const parts = [
          `Task completed: ${subagentTitle}.`,
          filesList.length ? `Files created/edited: ${filesList.join(', ')}.` : 'No files were modified.',
          toolsList.length ? `Tools utilized: ${toolsList.join(', ')}.` : ''
        ].filter(Boolean);
        finalSummary = parts.join('\n');
      }

      const totalDuration = Date.now() - startedAt;
      const isCancelled = isAborted();
      emit('subagent_done', {
        call_id: callId,
        title: subagentTitle,
        summary: finalSummary,
        tools_used: toolsList,
        files_modified: filesList,
        duration_ms: totalDuration,
        cancelled: isCancelled
      });

      return [
        `### Sub-Agent Task: ${subagentTitle} (${isCancelled ? 'Cancelled' : 'Completed'} in ${Math.round(totalDuration / 1000)}s)`,
        `**Status**: ${isCancelled ? 'Cancelled' : 'Completed'}`,
        `**Workspace**: ${targetWorkdir}`,
        `**Files Edited**: ${filesList.length ? filesList.map((f) => `\`${f}\``).join(', ') : 'None'}`,
        `**Tools Used**: ${toolsList.length ? toolsList.map((t) => `\`${t}\``).join(', ') : 'None'}`,
        `\n**Summary of Work Done**:\n${finalSummary}`
      ].join('\n');
    });
  });
}

