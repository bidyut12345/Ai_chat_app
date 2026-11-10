/**
 * Background Task Manager.
 *
 * Runs and tracks long-running background tasks (builds, servers, tests, scripts),
 * captures their stdout/stderr, supports timer-based check-backs, and provides
 * process tree termination for clean shutdowns and manual user kills.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileRoot, shellCwd } from './builtin/policy.js';

const IS_WINDOWS = process.platform === 'win32';
const OUTPUT_CAP = 120000;
const TASK_BUFFER = 200000;
const MAX_RECENT_TASKS = 50;

class BackgroundTaskManager extends EventEmitter {
  constructor() {
    super();
    // taskId -> task
    this.tasks = new Map();
  }

  pickShell(kind) {
    const k = String(kind || 'auto').toLowerCase();
    if (k === 'powershell' || k === 'pwsh') return { exe: k === 'pwsh' ? 'pwsh' : 'powershell', isPowerShell: true, args: [] };
    if (k === 'cmd') return { exe: 'cmd.exe', isPowerShell: false, args: ['/d', '/s', '/c'] };
    if (k === 'sh' || k === 'bash') return { exe: k, isPowerShell: false, args: ['-c'] };
    if (IS_WINDOWS) return { exe: 'cmd.exe', isPowerShell: false, args: ['/d', '/s', '/c'] };
    return { exe: '/bin/sh', isPowerShell: false, args: ['-c'] };
  }

  appendOutput(task, chunk) {
    if (!chunk) return;
    const str = chunk.toString('utf8');
    task.output += str;
    if (task.output.length > TASK_BUFFER) task.output = task.output.slice(-TASK_BUFFER);
    this.emit('task_output', { taskId: task.id, chunk: str });
  }

  tail(s, n = OUTPUT_CAP) {
    if (!s) return '';
    return s.length > n ? `...[earlier output truncated]\n${s.slice(-n)}` : s;
  }

  killTree(child) {
    if (!child || child.pid == null) return;
    try {
      if (IS_WINDOWS) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  startTask({ conversationId, command, name, cwd, shell }) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('command is required');
    const taskCwd = path.resolve(cwd || shellCwd() || fileRoot() || process.cwd());
    let { exe, args: shellArgs, isPowerShell } = this.pickShell(shell);
    const id = `task_${crypto.randomBytes(4).toString('hex')}`;
    const taskName = String(name || cmd.slice(0, 40) || 'Task').trim();

    let spawnArgs = [...shellArgs, cmd];
    let tempScript = null;

    if (isPowerShell || (IS_WINDOWS && (shell === 'auto' || !shell))) {
      tempScript = path.join(os.tmpdir(), `ri-bg-${id}.ps1`);
      fs.writeFileSync(tempScript, '\uFEFF' + cmd, 'utf8');
      exe = isPowerShell && exe !== 'powershell' ? exe : 'powershell.exe';
      spawnArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempScript];
    }

    const child = spawn(exe, spawnArgs, {
      cwd: taskCwd,
      windowsHide: true,
      env: { ...process.env, RI_TASK_ID: id }
    });

    const task = {
      id,
      conversationId: conversationId ? Number(conversationId) : null,
      name: taskName,
      command: cmd,
      cwd: taskCwd,
      shell: shell || 'auto',
      child,
      tempScript,
      pid: child.pid,
      output: '',
      status: 'running', // running, completed, failed, killed
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null
    };

    this.tasks.set(id, task);

    child.stdout?.on('data', (d) => this.appendOutput(task, d));
    child.stderr?.on('data', (d) => this.appendOutput(task, d));

    const cleanupScript = () => {
      if (tempScript) {
        try { fs.unlinkSync(tempScript); } catch {}
        tempScript = null;
      }
    };

    child.on('error', (e) => {
      cleanupScript();
      task.status = 'failed';
      task.endedAt = Date.now();
      task.output += `\n[spawn error] ${e.message}`;
      this.emit('task_finished', this.formatTask(task));
    });

    child.on('close', (code, signal) => {
      cleanupScript();
      if (task.status !== 'killed') {
        task.status = code === 0 ? 'completed' : 'failed';
      }
      task.endedAt = Date.now();
      task.exitCode = code;
      task.signal = signal;
      this.pruneTasks();
      this.emit('task_finished', this.formatTask(task));
    });

    this.emit('task_started', this.formatTask(task));
    return this.formatTask(task);
  }

  killTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No such task: ${id}`);
    if (task.status !== 'running') {
      return { ok: true, alreadyStopped: true, status: task.status, exitCode: task.exitCode };
    }
    task.status = 'killed';
    task.endedAt = Date.now();
    this.killTree(task.child);
    this.emit('task_killed', this.formatTask(task));
    return { ok: true, status: 'killed', id: task.id };
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this.formatTask(task) : null;
  }

  listTasks({ conversationId, all = false } = {}) {
    const list = [...this.tasks.values()]
      .filter((t) => {
        if (!all && conversationId != null && t.conversationId != null && t.conversationId !== Number(conversationId)) {
          return false;
        }
        return true;
      })
      .map((t) => this.formatTask(t))
      .sort((a, b) => b.startedAt - a.startedAt);
    return list;
  }

  runningCount(conversationId = null) {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        if (conversationId == null || t.conversationId == null || t.conversationId === Number(conversationId)) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Wait up to `waitSeconds` for a task to complete or progress.
   * If the task finishes before the timer, returns immediately.
   * Otherwise returns current running state and captured output tail.
   */
  async waitTaskTimer(id, waitSeconds = 5, intervalMs = 500) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No such task: ${id}`);

    const waitMs = Math.max(500, Math.min(300000, Number(waitSeconds) * 1000 || 5000));
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      if (task.status !== 'running') {
        break;
      }
      const remain = deadline - Date.now();
      const step = Math.min(remain, intervalMs);
      if (step <= 0) break;
      await new Promise((r) => setTimeout(r, step));
    }

    const formatted = this.formatTask(task);
    const elapsed = Date.now() - task.startedAt;
    const isRunning = task.status === 'running';

    let message = '';
    if (isRunning) {
      message = `Task "${task.name}" (${task.id}) is still running (elapsed: ${Math.round(elapsed / 1000)}s).\n` +
        `Output captured so far:\n${this.tail(task.output, 4000) || '(no output yet)'}`;
    } else {
      message = `Task "${task.name}" (${task.id}) ${task.status} in ${Math.round(elapsed / 1000)}s (exit code: ${task.exitCode ?? 'N/A'}).\n` +
        `Output:\n${this.tail(task.output, 8000) || '(no output)'}`;
    }

    return {
      task: formatted,
      message,
      status: task.status,
      running: isRunning,
      durationMs: elapsed,
      outputTail: this.tail(task.output, 4000)
    };
  }

  formatTask(task) {
    const now = Date.now();
    const durationMs = (task.endedAt || now) - task.startedAt;
    return {
      id: task.id,
      conversationId: task.conversationId,
      name: task.name,
      command: task.command,
      cwd: task.cwd,
      pid: task.pid,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      durationMs,
      exitCode: task.exitCode,
      signal: task.signal,
      outputTail: this.tail(task.output, 2000)
    };
  }

  pruneTasks() {
    if (this.tasks.size <= MAX_RECENT_TASKS) return;
    const completed = [...this.tasks.values()]
      .filter((t) => t.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    const toRemove = this.tasks.size - MAX_RECENT_TASKS;
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      this.tasks.delete(completed[i].id);
    }
  }

  stopAllTasks() {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        task.status = 'killed';
        task.endedAt = Date.now();
        this.killTree(task.child);
      }
    }
  }
}

export const backgroundTasks = new BackgroundTaskManager();

