/**
 * Built-in MCP server: `shell` (run shell commands).
 *
 * Foreground commands run to completion with a timeout; long-running ones can
 * be started in the background and polled. Nothing here is read-only, so with
 * approval mode 'ask' every call pauses until the user allows it.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCwd, shellTimeoutMs, PolicyError } from './policy.js';

const OUTPUT_CAP = 120000;
const JOB_BUFFER = 200000;

const IS_WINDOWS = process.platform === 'win32';

const jobs = new Map(); // id -> { id, command, cwd, child, output, startedAt, exited, exitCode, signal }

function pickShell(kind) {
  const k = String(kind || 'auto').toLowerCase();
  if (k === 'powershell' || k === 'pwsh') return { exe: k === 'pwsh' ? 'pwsh' : 'powershell', isPowerShell: true, args: [] };
  if (k === 'cmd') return { exe: 'cmd.exe', isPowerShell: false, args: ['/d', '/s', '/c'] };
  if (k === 'sh' || k === 'bash') return { exe: k, isPowerShell: false, args: ['-c'] };
  if (IS_WINDOWS) return { exe: 'cmd.exe', isPowerShell: false, args: ['/d', '/s', '/c'] };
  return { exe: '/bin/sh', isPowerShell: false, args: ['-c'] };
}

function appendOutput(job, chunk) {
  if (!chunk) return;
  job.output += chunk.toString('utf8');
  if (job.output.length > JOB_BUFFER) job.output = job.output.slice(-JOB_BUFFER);
}

function tail(s, n) {
  return s.length > n ? `...[earlier output truncated]\n${s.slice(-n)}` : s;
}

function jobSummary(job) {
  const state = job.exited ? `exited (code ${job.exitCode}${job.signal ? `, signal ${job.signal}` : ''})` : 'running';
  return `${job.id}  ${state}  cwd=${job.cwd}\n  $ ${job.command}`;
}

const str = (v) => (typeof v === 'string' ? v : '');

export const shellTools = [
  {
    name: 'run_command',
    destructive: true,
    description:
      'Run a shell command and wait for it to finish. Returns the exit code plus stdout and stderr. Use interpreter="powershell" to execute PowerShell scripts safely without cmd quoting. Default timeout 30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the configured shell folder.' },
        timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds. Default 30.' },
        shell: { type: 'string', enum: ['auto', 'cmd', 'powershell', 'pwsh', 'sh', 'bash'], description: 'Interpreter to use. Default auto.' },
        interpreter: { type: 'string', enum: ['auto', 'cmd', 'powershell', 'pwsh', 'sh', 'bash'], description: 'Interpreter to use (alias for shell).' },
        max_output_bytes: { type: 'number', description: 'Maximum output bytes to capture before truncating. Default 120000.' }
      },
      required: ['command']
    },
    async handler(args) {
      const command = str(args.command).trim();
      if (!command) throw new PolicyError('command is required');
      const cwd = resolveCwd(args.cwd);
      const requested = Number(args.timeout_seconds);
      const timeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 3600) * 1000 : 30000;
      const maxBytes = Math.min(Math.max(Number(args.max_output_bytes) || OUTPUT_CAP, 1000), 5000000);

      const targetShell = args.interpreter || args.shell || 'auto';
      const shellInfo = pickShell(targetShell);

      let tempFile = null;
      let exe = shellInfo.exe;
      let shellArgs = shellInfo.args;

      if (shellInfo.isPowerShell) {
        tempFile = path.join(os.tmpdir(), `rirsigpt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ps1`);
        fs.writeFileSync(tempFile, '\uFEFF' + command, 'utf8');
        shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile];
      }

      return await new Promise((resolve) => {
        const child = spawn(exe, [...shellArgs, ...(shellInfo.isPowerShell ? [] : [command])], { cwd, windowsHide: true, env: process.env });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeout);

        child.stdout.on('data', (d) => {
          stdout += d.toString('utf8');
          if (stdout.length > maxBytes * 1.5) stdout = stdout.slice(-maxBytes);
        });
        child.stderr.on('data', (d) => {
          stderr += d.toString('utf8');
          if (stderr.length > maxBytes * 1.5) stderr = stderr.slice(-maxBytes);
        });

        const finish = (code, signal, spawnError) => {
          clearTimeout(timer);
          if (tempFile) {
            try { fs.unlinkSync(tempFile); } catch {}
          }

          if (timedOut) {
            return resolve({
              ok: false,
              timed_out: true,
              exit_code: null,
              stdout: tail(stdout.trimEnd(), maxBytes),
              stderr: tail(stderr.trimEnd(), maxBytes),
              summary: `$ ${command}\nTimed out after ${Math.round(timeout / 1000)}s (timed_out: true)\n--- stdout ---\n${tail(stdout.trimEnd(), maxBytes)}\n--- stderr ---\n${tail(stderr.trimEnd(), maxBytes)}`
            });
          }

          if (!spawnError && code === 0 && !stderr.trim() && stdout.trim() === command.trim()) {
            return resolve({
              ok: false,
              error: 'command_not_executed',
              hint: 'use interpreter=powershell or -File',
              stdout: stdout.trim(),
              summary: `Error: command_not_executed\nHint: use interpreter=powershell or -File\nOutput was identical to command line: ${stdout.trim()}`
            });
          }

          const stdoutTruncated = stdout.length > maxBytes;
          const stderrTruncated = stderr.length > maxBytes;

          const parts = [
            `$ ${command}`,
            `cwd: ${cwd}`,
            `shell: ${exe}`,
            spawnError ? `error: ${spawnError.message}` : `exit: ${code}${signal ? ` (signal ${signal})` : ''}`
          ];
          if (stdoutTruncated || stderrTruncated) parts.push('[output truncated: exceeded max_output_bytes]');
          if (stdout.trim()) parts.push(`--- stdout ---\n${tail(stdout.trimEnd(), maxBytes)}`);
          if (stderr.trim()) parts.push(`--- stderr ---\n${tail(stderr.trimEnd(), maxBytes)}`);
          if (!stdout.trim() && !stderr.trim()) parts.push('(no output)');
          resolve(parts.join('\n'));
        };

        child.on('error', (e) => finish(null, null, e));
        child.on('close', (code, signal) => finish(code, signal, null));
      });
    }
  },

  {
    name: 'start_command',
    destructive: true,
    description: 'Start a long-running command in the background and return a job id straight away. Poll it with job_output and stop it with kill_process. Use for dev servers, watchers and builds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to run in the background.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the configured shell folder.' },
        shell: { type: 'string', enum: ['auto', 'cmd', 'powershell', 'pwsh', 'sh', 'bash'] }
      },
      required: ['command']
    },
    async handler(args) {
      const command = str(args.command).trim();
      if (!command) throw new PolicyError('command is required');
      const cwd = resolveCwd(args.cwd);
      const { exe, args: shellArgs } = pickShell(args.shell);
      const id = crypto.randomBytes(4).toString('hex');
      const child = spawn(exe, [...shellArgs, command], { cwd, windowsHide: true, env: process.env });

      const job = { id, command, cwd, child, output: '', startedAt: Date.now(), exited: false, exitCode: null, signal: null };
      jobs.set(id, job);
      child.stdout.on('data', (d) => appendOutput(job, d));
      child.stderr.on('data', (d) => appendOutput(job, d));
      child.on('error', (e) => {
        job.exited = true;
        job.output += `\n[spawn error] ${e.message}`;
      });
      child.on('close', (code, signal) => {
        job.exited = true;
        job.exitCode = code;
        job.signal = signal;
        pruneJobs();
      });

      return `Started background job ${id}\n$ ${command}\ncwd: ${cwd}\nUse job_output with job_id "${id}" to read its output.`;
    }
  },

  {
    name: 'job_output',
    readOnly: true,
    description: 'Read the output captured so far from a background job started with start_command.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by start_command.' },
        tail_lines: { type: 'number', description: 'Return only the last N lines. Default all (capped).' }
      },
      required: ['job_id']
    },
    async handler(args) {
      const job = jobs.get(str(args.job_id));
      if (!job) throw new PolicyError(`No such job. Running/recent jobs: ${[...jobs.keys()].join(', ') || 'none'}`);
      let out = job.output.trimEnd() || '(no output yet)';
      const n = Number(args.tail_lines);
      if (Number.isFinite(n) && n > 0) out = out.split(/\r?\n/).slice(-n).join('\n');
      const state = job.exited ? `exited (code ${job.exitCode}${job.signal ? `, signal ${job.signal}` : ''})` : `running for ${Math.round((Date.now() - job.startedAt) / 1000)}s`;
      return `${job.id} - ${state}\n$ ${job.command}\n--- output ---\n${tail(out, OUTPUT_CAP)}`;
    }
  },

  {
    name: 'list_jobs',
    readOnly: true,
    description: 'List background jobs started with start_command and whether they are still running.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      if (!jobs.size) return 'No background jobs.';
      return `${jobs.size} job(s):\n${[...jobs.values()].map(jobSummary).join('\n')}`;
    }
  },

  {
    name: 'kill_process',
    destructive: true,
    description: 'Stop a background job started with start_command.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id to stop.' } },
      required: ['job_id']
    },
    async handler(args) {
      const job = jobs.get(str(args.job_id));
      if (!job) throw new PolicyError(`No such job. Known jobs: ${[...jobs.keys()].join(', ') || 'none'}`);
      if (job.exited) return `Job ${job.id} had already exited (code ${job.exitCode}).`;
      killTree(job.child);
      return `Stopped job ${job.id} ($ ${job.command})`;
    }
  },

  {
    name: 'list_processes',
    readOnly: true,
    description: 'List the operating system processes visible to the app, to help identify what is running or holding a port.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Only show processes whose name or command contains this text.' } }
    },
    async handler(args) {
      const psCmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation';
      const [exe, exeArgs] = IS_WINDOWS
        ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]]
        : ['/bin/sh', ['-c', 'ps -eo pid,comm,args']];
      const r = spawnSync(exe, exeArgs, { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (r.error) throw new PolicyError(`Could not list processes: ${r.error.message}`);
      const f = str(args.filter).toLowerCase();
      const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      const kept = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
      return `Processes${f ? ` matching "${args.filter}"` : ''}:\n${tail(kept.join('\n'), OUTPUT_CAP) || '(none)'}`;
    }
  }
];

function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

function pruneJobs() {
  const finished = [...jobs.values()].filter((j) => j.exited);
  if (finished.length <= 20) return;
  for (const j of finished.sort((a, b) => a.startedAt - b.startedAt).slice(0, finished.length - 20)) {
    jobs.delete(j.id);
  }
}

/** Kill every background job (called on shutdown). */
export function stopAllJobs() {
  for (const job of jobs.values()) if (!job.exited) killTree(job.child);
}
