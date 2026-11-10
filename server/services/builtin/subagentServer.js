/**
 * Built-in Sub-Agent MCP Server.
 *
 * Tools:
 * - `plan_tasks`: Declare a step-by-step roadmap of tasks (renders a progress card in the UI).
 * - `run_task`: Delegates an individual task to an autonomous sub-agent with its own scoped
 *   workspace, filtered tools, and live progress reporting. The main agent pauses and waits
 *   until the subagent finishes and returns a summary.
 */
import { executeSubagentTask } from '../subagentService.js';
import { currentTurnContext } from '../chatService.js';
import { fileRoot } from './policy.js';

export const subagentTools = [
  {
    name: 'plan_tasks',
    readOnly: true,
    description: 'Declare or update a step-by-step roadmap of simple tasks before executing them. This publishes a clean unified task list with a progress bar to the UI. Always execute tasks sequentially one by one using run_task.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step ID, e.g. "step_1" or "1".' },
              title: { type: 'string', description: 'Short title for the step.' },
              description: { type: 'string', description: 'Summary of what this step will accomplish.' }
            },
            required: ['title']
          },
          description: 'Ordered list of task steps.'
        }
      },
      required: ['tasks']
    },
    async handler(args) {
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks = rawTasks.map((t, idx) => ({
        id: String(t.id || `step_${idx + 1}`),
        title: String(t.title || `Step ${idx + 1}`),
        description: String(t.description || '')
      }));

      const ctx = currentTurnContext();
      if (ctx?.emit) {
        ctx.emit('task_plan', { tasks });
      }

      return `Registered ${tasks.length} step(s) in task plan:\n` +
        tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.title}${t.description ? ` - ${t.description}` : ''}`).join('\n') +
        `\nNow call subagent__run_task for each step one by one.`;
    }
  },

  {
    name: 'run_task',
    destructive: true,
    description: 'Delegate a specific task to an autonomous sub-agent. The main agent pauses and waits while the sub-agent executes with the assigned tools and workspace. The sub-agent returns a detailed summary of actions taken and files modified. Sub-agents must be executed one by one sequentially.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive title of the task step (e.g. "Step 1: Check Database Schema").' },
        task: { type: 'string', description: 'Detailed instructions and objectives for the sub-agent to accomplish.' },
        context: { type: 'string', description: 'Relevant background information, prior findings, or data passed from previous steps.' },
        workspace: { type: 'string', description: 'Target folder for the sub-agent. Can be relative to chat workspace or an absolute path.' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allowed tool sets or names for the sub-agent (e.g. ["files"], ["files", "shell"], or ["background"]). Excludes subagent to prevent recursion.'
        },
        max_rounds: { type: 'number', description: 'Maximum tool interaction rounds for this sub-task (default: 8, max: 12).' }
      },
      required: ['task']
    },
    async handler(args) {
      const ctx = currentTurnContext();
      const conversation = ctx?.conversation || { workdir: fileRoot() };
      const cfg = ctx?.cfg || {};
      const emit = ctx?.emit || (() => {});
      const signal = ctx?.signal;
      const runObj = ctx?.runObj;
      const callId = ctx?.activeToolCallId;
      const callSignal = ctx?.activeCallSignal;

      const requestedTools = Array.isArray(args.tools) && args.tools.length
        ? args.tools
        : ['files', 'shell'];

      const summary = await executeSubagentTask({
        conversation,
        cfg,
        callId,
        title: args.title,
        task: args.task,
        context: args.context,
        workspace: args.workspace,
        tools: requestedTools,
        max_rounds: args.max_rounds,
        emit,
        signal,
        callSignal,
        runObj
      });

      return summary;
    }
  }
];

