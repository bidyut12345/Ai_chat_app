/**
 * Built-in Background Tasks MCP server.
 *
 * Exposes tools to run background commands, set timer checks, list tasks,
 * and stop running tasks.
 */
import { backgroundTasks } from '../backgroundTasks.js';
import { shellCwd } from './policy.js';

export const backgroundTools = [
  {
    name: 'run_task',
    destructive: true,
    description: 'Start a long-running command in the background and return a task ID immediately. Use wait_timer to check its progress or output after a few seconds, and kill_task to stop it. Great for test suites, watchers, servers, or large builds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the background.' },
        name: { type: 'string', description: 'Friendly name or label for this task.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the chat workspace.' },
        shell: { type: 'string', enum: ['auto', 'cmd', 'powershell', 'pwsh', 'sh', 'bash'], description: 'Shell interpreter to use.' }
      },
      required: ['command']
    },
    async handler(args) {
      const task = backgroundTasks.startTask({
        command: args.command,
        name: args.name,
        cwd: args.cwd || shellCwd(),
        shell: args.shell
      });
      return `Started background task "${task.name}" (ID: ${task.id})\n` +
        `Command: $ ${task.command}\n` +
        `CWD: ${task.cwd}\n` +
        `Status: ${task.status}\n` +
        `Use background__wait_timer with task_id "${task.id}" and wait_seconds (e.g. 5 or 10) to check back on its result.`;
    }
  },

  {
    name: 'wait_timer',
    readOnly: true,
    description: 'Set a timer to wait for a background task and check back on its status and output. Waits up to wait_seconds (or until the task completes) and returns the output captured so far.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Background task ID returned by run_task.' },
        wait_seconds: { type: 'number', description: 'How many seconds to wait before checking back (default: 5, max: 300).' }
      },
      required: ['task_id']
    },
    async handler(args) {
      const outcome = await backgroundTasks.waitTaskTimer(args.task_id, args.wait_seconds || 5);
      return outcome.message;
    }
  },

  {
    name: 'list_tasks',
    readOnly: true,
    description: 'List running and recent background tasks, their status, runtime, and exit codes.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Whether to list tasks from all chats (default: false).' }
      }
    },
    async handler(args) {
      const list = backgroundTasks.listTasks({ all: !!args.all });
      if (!list.length) return 'No background tasks found.';
      return `${list.length} task(s):\n` + list.map((t) => {
        const dur = Math.round(t.durationMs / 1000);
        return `• [${t.status}] ${t.id} "${t.name}" (${dur}s) - $ ${t.command}`;
      }).join('\n');
    }
  },

  {
    name: 'kill_task',
    destructive: true,
    description: 'Stop and terminate a running background task process tree.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to terminate.' }
      },
      required: ['task_id']
    },
    async handler(args) {
      const res = backgroundTasks.killTask(args.task_id);
      return `Terminated background task ${args.task_id} (status: ${res.status}).`;
    }
  }
];

