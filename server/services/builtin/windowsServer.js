/**
 * Built-in MCP server: `windows` (Windows desktop automation).
 *
 * Window management, launching apps, UI Automation (UIA) inspection, keyboard / mouse input,
 * clipboard and screenshots.
 *
 * Guidance for coding agents:
 * - Prefer write file -> open by path over simulating keystrokes. It is deterministic and cannot corrupt an unrelated tab.
 * - Treat launch_app handle as advisory until confirmed by find_window.
 * - Enumerate windows before mutating, never only after.
 * - Never type into a document with unsaved changes without an explicit flag (allow_unsaved: true).
 * - Call uia_inspect after every mutation to confirm the intended effect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, resolveCwd, PolicyError } from './policy.js';
import { runPs, runPsLines, WINLIB, FIND_WINDOW, FOCUS_TARGET, IS_WINDOWS } from './win32.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const ACTION_WORDS = ['minimize', 'maximize', 'restore', 'close', 'move', 'resize'];

function requireWindows() {
  if (!IS_WINDOWS) throw new PolicyError('The Windows automation tools only work on Windows.');
}

/** Stable timestamp for default screenshot names. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Escape one line of literal text for SendKeys. */
function literalKeys(line) {
  return line.replace(/([+^%~()[\]{}])/g, '{$1}');
}

/** Whole multi-line string -> SendKeys, with newlines as {ENTER}. */
function sendKeysLiteral(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(literalKeys)
    .join('{ENTER}');
}

function stateOf(state) {
  return state === 'minimized' ? 'minimized' : state === 'maximized' ? 'maximized' : 'normal';
}

export const windowsTools = [
  {
    name: 'system_info',
    readOnly: true,
    description:
      'Describe this Windows machine: computer name, user, OS version, uptime and the size/position of every screen. Use it before clicking at absolute coordinates.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      requireWindows();
      const info = runPs(
        `Add-Type -AssemblyName System.Windows.Forms
$os = Get-CimInstance Win32_OperatingSystem
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ device = $_.DeviceName; primary = [bool]$_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
})
[pscustomobject]@{
  computer = $env:COMPUTERNAME
  user = $env:USERNAME
  os = $os.Caption
  version = $os.Version
  uptime_hours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  screens = $screens
} | ConvertTo-Json -Depth 5 -Compress`,
        { json: true, timeout: 45000 }
      );
      const screens = Array.isArray(info.screens) ? info.screens : info.screens ? [info.screens] : [];
      const lines = [
        `Computer: ${info.computer}`,
        `User: ${info.user}`,
        `OS: ${info.os} (${info.version})`,
        `Uptime: ${info.uptime_hours} h`,
        `Screens (${screens.length}):`
      ];
      for (const s of screens) {
        lines.push(`  ${s.device}  ${s.width}x${s.height}  at ${s.x},${s.y}${s.primary ? '  (primary)' : ''}`);
      }
      return lines.join('\n');
    }
  },

  {
    name: 'list_windows',
    readOnly: true,
    description:
      'List the visible top-level windows: handle, process, title, class name, state and position. Always call list_windows or find_window before mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only show windows whose title or process contains this text.' }
      }
    },
    async handler(args) {
      requireWindows();
      const rows = runPsLines(
        `${WINLIB}
foreach ($w in [RWin]::ListWindows()) {
  [pscustomobject]@{
    handle = $w.Handle
    pid = $w.Pid
    process = $w.Process
    title = $w.Title
    class_name = $w.ClassName
    state = $w.State
    x = $w.X
    y = $w.Y
    width = $w.Width
    height = $w.Height
    foreground = $w.Foreground
    is_dirty = $w.IsDirty
  } | ConvertTo-Json -Compress
}`,
        { timeout: 45000 }
      );
      const f = str(args.filter).trim().toLowerCase();
      const kept = f ? rows.filter((r) => `${r.title} ${r.process} ${r.class_name}`.toLowerCase().includes(f)) : rows;
      if (!kept.length) return f ? `No window matches "${args.filter}".` : 'No visible windows.';
      kept.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      const lines = kept.map((r) => {
        const size = `${r.width}x${r.height} at ${r.x},${r.y}`;
        const mark = r.foreground ? '  [focused]' : '';
        const dirtyMark = r.is_dirty ? '  [unsaved changes]' : '';
        return `handle ${r.handle}  pid ${r.pid}  ${r.process}  (${r.class_name})  ${stateOf(r.state)}  ${size}  ${r.title}${mark}${dirtyMark}`;
      });
      return `${kept.length} window(s):\n${lines.join('\n')}`;
    }
  },

  {
    name: 'find_window',
    readOnly: true,
    description:
      'Find open top-level windows matching title substring, class name, or process ID. Returns fresh handles. Treat launch_app handles as advisory until confirmed by find_window.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Substring to match in window title (case-insensitive).' },
        class_name: { type: 'string', description: 'Match class name (e.g. "Notepad", "ApplicationFrameWindow").' },
        pid: { type: 'number', description: 'Process ID that owns the window.' }
      }
    },
    async handler(args) {
      requireWindows();
      const rows = runPsLines(
        `${WINLIB}
foreach ($w in [RWin]::ListWindows()) {
  [pscustomobject]@{
    handle = $w.Handle
    pid = $w.Pid
    process = $w.Process
    title = $w.Title
    class_name = $w.ClassName
    state = $w.State
    x = $w.X
    y = $w.Y
    width = $w.Width
    height = $w.Height
    foreground = $w.Foreground
    is_dirty = $w.IsDirty
  } | ConvertTo-Json -Compress
}`,
        { timeout: 30000 }
      );
      const titleSub = str(args.title_contains).trim().toLowerCase();
      const classSub = str(args.class_name).trim().toLowerCase();
      const targetPid = Number(args.pid) || 0;

      const kept = rows.filter((r) => {
        if (titleSub && !String(r.title).toLowerCase().includes(titleSub)) return false;
        if (classSub && !String(r.class_name).toLowerCase().includes(classSub)) return false;
        if (targetPid && r.pid !== targetPid) return false;
        return true;
      });

      return {
        count: kept.length,
        windows: kept.map((r) => ({
          handle: r.handle,
          pid: r.pid,
          process: r.process,
          title: r.title,
          class_name: r.class_name,
          state: stateOf(r.state),
          rect: [r.x, r.y, r.width, r.height],
          foreground: r.foreground,
          is_dirty: r.is_dirty
        }))
      };
    }
  },

  {
    name: 'uia_inspect',
    readOnly: true,
    description:
      'Inspect UI elements and control values using Windows UI Automation (UIA). Reads control names, types, values (ValuePattern/TextPattern), and coordinates. Primary verification primitive to verify UI state without screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: 'Window handle from list_windows or find_window (required).' },
        scope: { type: 'string', enum: ['descendants', 'children', 'element'], description: 'Traversal scope. Default descendants.' },
        control_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by control type, e.g. ["Text", "Button", "Edit", "Document", "ListItem"].'
        },
        name_contains: { type: 'string', description: 'Filter elements whose name contains this substring (case-insensitive).' },
        max_nodes: { type: 'number', description: 'Maximum elements to return. Default 200.' },
        text_only: { type: 'boolean', description: 'Return flattened visible text instead of element tree. Default false.' }
      },
      required: ['handle']
    },
    async handler(args) {
      requireWindows();
      const handle = Number(args.handle) || 0;
      if (!handle) throw new PolicyError('handle is required for uia_inspect');
      const scope = ['children', 'element'].includes(args.scope) ? args.scope : 'descendants';
      const maxNodes = Math.min(Math.max(Number(args.max_nodes) || 200, 1), 1000);
      const textOnly = args.text_only === true || str(args.text_only) === 'true';
      const types = Array.isArray(args.control_types) ? args.control_types.join(',') : '';
      const nameSub = str(args.name_contains).trim();

      const res = runPs(
        `${WINLIB}${FIND_WINDOW}
$h = Resolve-Handle -Handle ([long]$env:RI_HANDLE) -Title ''
$types = @()
if ($env:RI_TYPES) { $types = $env:RI_TYPES.Split(',') }
$res = [RWin]::InspectUia($h, $env:RI_SCOPE, $types, $env:RI_NAME_SUB, [int]$env:RI_MAX_NODES, ($env:RI_TEXT_ONLY -eq '1'))
$hint = if ($res.count -eq 0 -and -not $res.error) { 'No matching UIA nodes found for filter' } else { $null }
[pscustomobject]@{
  count = $res.count
  nodes = $res.nodes
  text = $res.text
  error = $res.error
  hint = $hint
} | ConvertTo-Json -Depth 5 -Compress`,
        {
          env: {
            RI_HANDLE: String(handle),
            RI_SCOPE: scope,
            RI_MAX_NODES: String(maxNodes),
            RI_TEXT_ONLY: textOnly ? '1' : '0',
            RI_TYPES: types,
            RI_NAME_SUB: nameSub
          },
          json: true,
          timeout: 45000
        }
      );

      return {
        count: res.count || 0,
        nodes: res.nodes || [],
        ...(textOnly ? { text: res.text || '' } : {}),
        error: res.error || null,
        ...(res.hint ? { hint: res.hint } : {})
      };
    }
  },

  {
    name: 'focus_window',
    destructive: true,
    description: 'Bring a window to the front so it receives keyboard and mouse input. Match it by handle (preferred) or by unique title.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: 'Window handle from list_windows or find_window.' },
        title: { type: 'string', description: 'Window title (must match uniquely if handle is omitted).' }
      }
    },
    async handler(args) {
      requireWindows();
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      if (!handle && !title) throw new PolicyError('Give a window handle or a title.');
      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE -AllowUnsaved
[pscustomobject]@{ handle = $h.ToInt64(); title = [RWin]::TitleOf($h); class_name = [RWin]::ClassNameOf($h) } | ConvertTo-Json -Compress`,
        { env: { RI_HANDLE: String(handle), RI_TITLE: title }, json: true, timeout: 30000 }
      );
      return `Focused "${res.title}" (class: ${res.class_name}, handle ${res.handle})`;
    }
  },

  {
    name: 'window_action',
    destructive: true,
    description:
      'Change one window: minimize, maximize, restore, close, move to x/y, or resize to width/height. Match the window by handle (preferred) or unique title.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTION_WORDS, description: 'What to do with the window.' },
        handle: { type: 'number', description: 'Window handle from list_windows.' },
        title: { type: 'string', description: 'Window title, or a distinctive part of it.' },
        x: { type: 'number', description: 'New left edge (move).' },
        y: { type: 'number', description: 'New top edge (move).' },
        width: { type: 'number', description: 'New width (resize).' },
        height: { type: 'number', description: 'New height (resize).' }
      },
      required: ['action']
    },
    async handler(args) {
      requireWindows();
      const action = str(args.action).trim().toLowerCase();
      if (!ACTION_WORDS.includes(action)) throw new PolicyError(`action must be one of ${ACTION_WORDS.join(', ')}`);
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      if (!handle && !title) throw new PolicyError('Give a window handle or a title.');
      if (action === 'move' && (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y)))) {
        throw new PolicyError('move needs x and y.');
      }
      if (action === 'resize' && (!Number.isFinite(Number(args.width)) || !Number.isFinite(Number(args.height)))) {
        throw new PolicyError('resize needs width and height.');
      }
      const res = runPs(
        `${WINLIB}${FIND_WINDOW}
$h = [IntPtr](Resolve-Handle -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE)
switch ($env:RI_ACTION) {
  'minimize' { [RWin]::ShowWindow($h, 6) | Out-Null }
  'maximize' { [RWin]::ShowWindow($h, 3) | Out-Null }
  'restore'  { [RWin]::ShowWindow($h, 9) | Out-Null }
  'close'    { [RWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  'move'     { [RWin]::SetWindowPos($h, [IntPtr]::Zero, [int]$env:RI_X, [int]$env:RI_Y, 0, 0, 0x0005) | Out-Null }
  'resize'   { [RWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, [int]$env:RI_W, [int]$env:RI_H, 0x0006) | Out-Null }
  default    { throw ('Unknown action ' + $env:RI_ACTION) }
}
Start-Sleep -Milliseconds 200
$alive = [RWin]::IsWindow($h)
$title = [RWin]::TitleOf($h)
$rect = @()
$state = 'closed'
if ($alive) {
  $rect = [RWin]::RectOf($h)
  $state = if ([RWin]::IsIconic($h)) { 'minimized' } elseif ([RWin]::IsZoomed($h)) { 'maximized' } else { 'normal' }
}
[pscustomobject]@{
  handle = $h.ToInt64()
  title = $title
  closed = (-not $alive)
  state = $state
  x = $(if ($rect.Length -ge 4) { $rect[0] } else { $null })
  y = $(if ($rect.Length -ge 4) { $rect[1] } else { $null })
  width = $(if ($rect.Length -ge 4) { $rect[2] } else { $null })
  height = $(if ($rect.Length -ge 4) { $rect[3] } else { $null })
} | ConvertTo-Json -Compress`,
        {
          env: {
            RI_HANDLE: String(handle),
            RI_TITLE: title,
            RI_ACTION: action,
            RI_X: String(Number(args.x) || 0),
            RI_Y: String(Number(args.y) || 0),
            RI_W: String(Number(args.width) || 0),
            RI_H: String(Number(args.height) || 0)
          },
          json: true,
          timeout: 30000
        }
      );
      if (res.closed) return `${action} -> window closed (handle ${res.handle}).`;
      return `${action} -> "${res.title}"  ${stateOf(res.state)}  ${res.width}x${res.height} at ${res.x},${res.y}  (handle ${res.handle})`;
    }
  },

  {
    name: 'launch_app',
    destructive: true,
    description:
      'Start a program, document or URL. Resolves the real UI window, supporting modern UWP/Store apps and ApplicationFrameHost. Note: Prefer write file -> open by path over simulating keystrokes. Treat launch_app handle as advisory until confirmed by find_window.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Executable path, document path or URL.' },
        arguments: { type: 'string', description: 'Command line arguments for the program, as one string.' },
        working_dir: { type: 'string', description: 'Working directory for the new process.' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds to wait for the UI window (default 3000).' },
        new_instance: { type: 'boolean', description: 'Force a separate process instance if supported (default false).' }
      },
      required: ['target']
    },
    async handler(args) {
      requireWindows();
      const target = str(args.target).trim();
      if (!target) throw new PolicyError('target is required.');
      const cwd = args.working_dir ? resolveCwd(args.working_dir) : '';
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 3000, 500), 30000);
      const newInstance = args.new_instance === true || str(args.new_instance) === 'true';

      const res = runPs(
        `${WINLIB}
$before = @([RWin]::ListWindows())
$beforeHandles = @($before | ForEach-Object { $_.Handle })
$target = $env:RI_TARGET
$rawExe = [System.IO.Path]::GetFileNameWithoutExtension($target)
$exe = if ($rawExe) { $rawExe.TrimEnd(':') } else { '' }
$args = $env:RI_ARGS
$newInstance = ($env:RI_NEW_INSTANCE -eq '1')
if ($newInstance -and ($exe -ieq 'notepad')) {
  if ($args -notmatch '/n\b') { $args = ('/n ' + $args).Trim() }
}

$start = @{ FilePath = $target; PassThru = $true }
if ($args) { $start['ArgumentList'] = $args }
if ($env:RI_CWD) { $start['WorkingDirectory'] = $env:RI_CWD }
$p = $null
try {
  $p = Start-Process @start
} catch {
  # If file path / URI protocol execution
  Start-Process -FilePath $target
}

$timeoutMs = [int]$env:RI_TIMEOUT_MS
if ($timeoutMs -le 0) { $timeoutMs = 3000 }
$deadline = (Get-Date).AddMilliseconds($timeoutMs)

$found = $null
$reused = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 150
  $now = @([RWin]::ListWindows())
  $new = @($now | Where-Object { $beforeHandles -notcontains $_.Handle -and $_.Title -ne 'PopupHost' -and $_.ClassName -ne 'Microsoft.UI.Content.PopupWindowSiteBridge' })

  if ($new.Count -gt 0) {
    if ($p) {
      $matchPid = $new | Where-Object { $_.Pid -eq $p.Id -and $_.Width -gt 50 } | Select-Object -First 1
      if ($matchPid) { $found = $matchPid; break }
    }
    $matchName = $new | Where-Object { ($exe -and ($_.Process -ilike ('*' + $exe + '*') -or $_.Title -ilike ('*' + $exe + '*'))) -or $_.ClassName -ieq 'ApplicationFrameWindow' } | Select-Object -First 1
    if ($matchName) { $found = $matchName; break }
  }
}

if ($found -and -not [RWin]::IsWindowOnDefault($found.Handle)) {
  $found = $null
}

if (-not $found) {
  $existing = @([RWin]::ListWindows() | Where-Object { $exe -and ($_.Process -ilike ('*' + $exe + '*') -or $_.Title -ilike ('*' + $exe + '*')) }) | Select-Object -First 1
  if ($existing) {
    $found = $existing
    $reused = $true
  }
} else {
  $wasExisting = @($before | Where-Object { $_.Handle -eq $found.Handle }).Count -gt 0
  if ($wasExisting) {
    $reused = $true
  } elseif ($p -and $p.Id -ne $found.Pid -and @($before | Where-Object { $_.Pid -eq $found.Pid }).Count -gt 0) {
    $reused = $true
  }
}

$handle = if ($found) { $found.Handle } else { 0 }
$title = if ($found) { $found.Title } else { '' }
$className = if ($found) { $found.ClassName } else { '' }
$owningPid = if ($found) { $found.Pid } else { 0 }
$reqPid = if ($p) { $p.Id } else { 0 }

[pscustomobject]@{
  requested_pid = $reqPid
  owning_pid = $owningPid
  handle = $handle
  class_name = $className
  title = $title
  reused_existing_instance = $reused
  target = $target
} | ConvertTo-Json -Compress`,
        {
          env: {
            RI_TARGET: target,
            RI_ARGS: str(args.arguments),
            RI_CWD: cwd,
            RI_TIMEOUT_MS: String(timeoutMs),
            RI_NEW_INSTANCE: newInstance ? '1' : '0'
          },
          json: true,
          timeout: timeoutMs + 15000
        }
      );

      const procName = res.target;
      const reusedNote = res.reused_existing_instance
        ? '\n[reused_existing_instance: true - joined an existing session with user data! Keystrokes will be blocked without allow_unsaved: true]'
        : '\n[reused_existing_instance: false]';
      if (res.handle) {
        return {
          requested_pid: res.requested_pid,
          owning_pid: res.owning_pid,
          handle: res.handle,
          class_name: res.class_name,
          title: res.title,
          reused_existing_instance: !!res.reused_existing_instance,
          summary: `Started ${procName} (requested pid ${res.requested_pid}, owning pid ${res.owning_pid})\nWindow: "${res.title}"  handle ${res.handle} (class: ${res.class_name})${reusedNote}`
        };
      }
      return {
        requested_pid: res.requested_pid,
        owning_pid: res.owning_pid,
        handle: 0,
        class_name: '',
        title: '',
        reused_existing_instance: false,
        summary: `Opened ${procName}. No visible UI window found within timeout — use find_window to locate it.`
      };
    }
  },

  {
    name: 'screenshot',
    readOnly: true,
    description:
      'Save a PNG of the screen (or of one window) into the chat folder. Note: PNG is not visible to the model; use uia_inspect to verify UI state. Set annotate: true to draw coordinate grid lines.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to save the PNG, relative to the chat folder. Defaults to screenshot-<timestamp>.png.' },
        handle: { type: 'number', description: 'Capture only this window (handle from list_windows). Omit for the whole screen.' },
        annotate: { type: 'boolean', description: 'Draw coordinate grid overlay on the image. Default false.' }
      }
    },
    async handler(args) {
      requireWindows();
      const rel = str(args.path).trim() || `screenshot-${stamp()}.png`;
      const abs = resolvePath(rel, { mustExist: false });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const handle = Number(args.handle) || 0;
      const annotate = args.annotate === true || str(args.annotate) === 'true';

      const res = runPs(
        `${WINLIB}${FIND_WINDOW}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$h = [long]$env:RI_HANDLE
if ($h -ne 0) {
  $resolved = Resolve-Handle -Handle $h -Title ''
  if ([RWin]::IsIconic([IntPtr]$resolved)) { throw 'That window is minimized, so there is nothing on screen to capture. Restore it first.' }
  $rect = [RWin]::RectOf([IntPtr]$resolved)
  if ($rect.Length -lt 4) { throw 'Could not read that window screen rectangle.' }
  $x = $rect[0]; $y = $rect[1]; $w = $rect[2]; $ht = $rect[3]
} else {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = $b.X; $y = $b.Y; $w = $b.Width; $ht = $b.Height
}
if ($w -le 0 -or $ht -le 0) { throw 'Nothing to capture.' }
$bmp = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
} catch {
  $g.Dispose(); $bmp.Dispose()
  throw ('Could not read the screen (' + $_.Exception.Message + '). This happens when the desktop is locked or the screen is off; unlock it and try again.')
}

if ($env:RI_ANNOTATE -eq '1') {
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 0, 200, 255)), 1
  $font = New-Object System.Drawing.Font 'Arial', 9
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 0, 200, 255))
  for ($gx = 100; $gx -lt $w; $gx += 100) { $g.DrawLine($pen, $gx, 0, $gx, $ht) }
  for ($gy = 100; $gy -lt $ht; $gy += 100) { $g.DrawLine($pen, 0, $gy, $w, $gy) }
  for ($gx = 100; $gx -lt $w; $gx += 200) {
    for ($gy = 100; $gy -lt $ht; $gy += 200) {
      $g.DrawString(('(' + $gx + ',' + $gy + ')'), $font, $brush, [float]($gx + 2), [float]($gy + 2))
    }
  }
  $pen.Dispose(); $font.Dispose(); $brush.Dispose()
}

$bmp.Save($env:RI_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[pscustomobject]@{
  path = $env:RI_PATH
  width = $w
  height = $ht
  readable = $true
  annotated = ($env:RI_ANNOTATE -eq '1')
} | ConvertTo-Json -Compress`,
        { env: { RI_PATH: abs, RI_HANDLE: String(handle), RI_ANNOTATE: annotate ? '1' : '0' }, json: true, timeout: 30000 }
      );
      const bytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
      return {
        path: res.path,
        width: res.width,
        height: res.height,
        readable: true,
        annotated: res.annotated,
        summary: `Saved ${res.width}x${res.height} PNG (${bytes} bytes)${annotate ? ' [annotated with coordinate grid]' : ''}\n${res.path}`
      };
    }
  },

  {
    name: 'send_keys',
    destructive: true,
    description:
      'Send keystrokes to a window using SendKeys syntax: ^s = Ctrl+S, %{F4} = Alt+F4, {ENTER}, {TAB}, {ESC}. Require handle. Fails closed if the window has unsaved changes unless allow_unsaved: true.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'SendKeys string, e.g. "^s" or "{ENTER}".' },
        handle: { type: 'number', description: 'Window handle from list_windows or find_window (strongly preferred).' },
        title: { type: 'string', description: 'Window title (must match uniquely if handle is omitted).' },
        allow_unsaved: { type: 'boolean', description: 'Allow typing into a window with unsaved changes. Default false.' },
        dry_run: { type: 'boolean', description: 'Resolve target window without typing. Default false.' },
        expect: { type: 'string', description: 'Post-condition: verify control text contains this string after typing.' }
      },
      required: ['keys']
    },
    async handler(args) {
      requireWindows();
      const keys = str(args.keys);
      if (!keys) throw new PolicyError('keys is required.');
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      const allowUnsaved = args.allow_unsaved === true || str(args.allow_unsaved) === 'true';
      const dryRun = args.dry_run === true || str(args.dry_run) === 'true';
      const expect = str(args.expect);

      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
Add-Type -AssemblyName System.Windows.Forms
$allowUnsaved = ($env:RI_ALLOW_UNSAVED -eq '1')
$dryRun = ($env:RI_DRY_RUN -eq '1')
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE -AllowUnsaved:$allowUnsaved

$targetTitle = if ($h -eq [IntPtr]::Zero) { [RWin]::ForegroundTitle() } else { [RWin]::TitleOf($h) }
$targetClass = if ($h -eq [IntPtr]::Zero) { '' } else { [RWin]::ClassNameOf($h) }

if ($dryRun) {
  [pscustomobject]@{
    dry_run = $true
    handle = $h.ToInt64()
    title = $targetTitle
    class_name = $targetClass
    typed = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ($targetClass -ieq 'ApplicationFrameWindow' -or $targetTitle -ilike '*Calculator*') {
  if (-not [RWin]::TryUiaInvokeCalc($h.ToInt64(), $env:RI_KEYS)) {
    [RWin]::SendKeysWait($env:RI_KEYS)
  }
} else {
  [RWin]::SendKeysWait($env:RI_KEYS)
}
Start-Sleep -Milliseconds 120

$actual = ''
$matched = $null
if ($env:RI_EXPECT) {
  $actual = [RWin]::ReadCurrentText($h.ToInt64())
  $matched = $actual.Contains($env:RI_EXPECT)
}

[pscustomobject]@{
  handle = $h.ToInt64()
  title = $targetTitle
  typed = $true
  expect = $env:RI_EXPECT
  matched = $matched
  actual = $actual
} | ConvertTo-Json -Compress`,
        {
          env: {
            RI_KEYS: keys,
            RI_HANDLE: String(handle),
            RI_TITLE: title,
            RI_ALLOW_UNSAVED: allowUnsaved ? '1' : '0',
            RI_DRY_RUN: dryRun ? '1' : '0',
            RI_EXPECT: expect
          },
          json: true,
          timeout: 30000
        }
      );

      if (res.dry_run) {
        return `Dry run: target window resolved to "${res.title}" (handle ${res.handle}, class: ${res.class_name}). No keystrokes were sent.`;
      }
      const expNote = expect ? `\nExpectation check: matched=${res.matched} (expected: "${expect}", actual: "${res.actual}")` : '';
      return `Sent ${keys.length} character(s) of keystrokes to "${res.title}".${expNote}`;
    }
  },

  {
    name: 'type_text',
    destructive: true,
    description:
      'Type literal text into the focused window. Require handle. Special characters are escaped for you. Fails closed if the window has unsaved changes unless allow_unsaved: true.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        handle: { type: 'number', description: 'Window handle from list_windows or find_window (strongly preferred).' },
        title: { type: 'string', description: 'Window title (must match uniquely if handle is omitted).' },
        allow_unsaved: { type: 'boolean', description: 'Allow typing into a window with unsaved changes. Default false.' },
        dry_run: { type: 'boolean', description: 'Resolve target window without typing. Default false.' },
        expect: { type: 'string', description: 'Post-condition: verify control text contains this string after typing.' }
      },
      required: ['text']
    },
    async handler(args) {
      requireWindows();
      const text = str(args.text);
      if (!text) throw new PolicyError('text is required.');
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      const allowUnsaved = args.allow_unsaved === true || str(args.allow_unsaved) === 'true';
      const dryRun = args.dry_run === true || str(args.dry_run) === 'true';
      const expect = str(args.expect);

      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
Add-Type -AssemblyName System.Windows.Forms
$allowUnsaved = ($env:RI_ALLOW_UNSAVED -eq '1')
$dryRun = ($env:RI_DRY_RUN -eq '1')
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE -AllowUnsaved:$allowUnsaved

$targetTitle = if ($h -eq [IntPtr]::Zero) { [RWin]::ForegroundTitle() } else { [RWin]::TitleOf($h) }
$targetClass = if ($h -eq [IntPtr]::Zero) { '' } else { [RWin]::ClassNameOf($h) }

if ($dryRun) {
  [pscustomobject]@{
    dry_run = $true
    handle = $h.ToInt64()
    title = $targetTitle
    class_name = $targetClass
    typed = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ($targetClass -ieq 'ApplicationFrameWindow' -or $targetTitle -ilike '*Calculator*') {
  if (-not [RWin]::TryUiaInvokeCalc($h.ToInt64(), $env:RI_KEYS)) {
    [RWin]::SendKeysWait($env:RI_KEYS)
  }
} else {
  [RWin]::SendKeysWait($env:RI_KEYS)
}
Start-Sleep -Milliseconds 120

$actual = ''
$matched = $null
if ($env:RI_EXPECT) {
  $actual = [RWin]::ReadCurrentText($h.ToInt64())
  $matched = $actual.Contains($env:RI_EXPECT)
}

[pscustomobject]@{
  handle = $h.ToInt64()
  title = $targetTitle
  typed = $true
  expect = $env:RI_EXPECT
  matched = $matched
  actual = $actual
} | ConvertTo-Json -Compress`,
        {
          env: {
            RI_KEYS: sendKeysLiteral(text),
            RI_HANDLE: String(handle),
            RI_TITLE: title,
            RI_ALLOW_UNSAVED: allowUnsaved ? '1' : '0',
            RI_DRY_RUN: dryRun ? '1' : '0',
            RI_EXPECT: expect
          },
          json: true,
          timeout: 30000
        }
      );

      if (res.dry_run) {
        return `Dry run: target window resolved to "${res.title}" (handle ${res.handle}, class: ${res.class_name}). No keystrokes were sent.`;
      }
      const expNote = expect ? `\nExpectation check: matched=${res.matched} (expected: "${expect}", actual: "${res.actual}")` : '';
      return `Typed ${text.length} character(s) into "${res.title}".${expNote}`;
    }
  },

  {
    name: 'mouse_click',
    destructive: true,
    description: 'Move the mouse to absolute screen coordinates and click. Coordinates are physical pixels — see system_info for the screen size.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal screen coordinate.' },
        y: { type: 'number', description: 'Vertical screen coordinate.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Which button. Default left.' },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' }
      },
      required: ['x', 'y']
    },
    async handler(args) {
      requireWindows();
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PolicyError('x and y must be numbers.');
      const button = ['left', 'right', 'middle'].includes(str(args.button)) ? str(args.button) : 'left';
      const dbl = args.double === true || str(args.double) === 'true';
      const res = runPs(
        `${WINLIB}
$flags = switch ($env:RI_BUTTON) {
  'right'  { @(0x0008, 0x0010) }
  'middle' { @(0x0020, 0x0040) }
  default  { @(0x0002, 0x0004) }
}
[RWin]::SetCursorPos([int]$env:RI_X, [int]$env:RI_Y) | Out-Null
$count = if ($env:RI_DOUBLE -eq '1') { 2 } else { 1 }
for ($i = 0; $i -lt $count; $i++) {
  [RWin]::mouse_event($flags[0], 0, 0, 0, [IntPtr]::Zero)
  [RWin]::mouse_event($flags[1], 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
[pscustomobject]@{ x = [int]$env:RI_X; y = [int]$env:RI_Y; button = $env:RI_BUTTON; clicks = $count } | ConvertTo-Json -Compress`,
        { env: { RI_X: String(x), RI_Y: String(y), RI_BUTTON: button, RI_DOUBLE: dbl ? '1' : '0' }, json: true, timeout: 30000 }
      );
      return `${res.clicks === 2 ? 'Double-clicked' : 'Clicked'} ${res.button} at ${res.x},${res.y}.`;
    }
  },

  {
    name: 'clipboard_get',
    readOnly: true,
    description: 'Read the current clipboard text.',
    inputSchema: {
      type: 'object',
      properties: {
        max_chars: { type: 'number', description: 'Truncate the returned text. Default 20000.' }
      }
    },
    async handler(args) {
      requireWindows();
      const res = runPs(
        `$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue
if ($null -eq $t) { $t = '' }
[pscustomobject]@{ length = $t.Length; text = $t } | ConvertTo-Json -Compress`,
        { json: true, timeout: 20000 }
      );
      const max = Math.min(Math.max(Number(args.max_chars) || 20000, 1), 200000);
      const text = str(res.text);
      const shown = text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
      return `Clipboard (${res.length} chars):\n${shown || '(empty)'}`;
    }
  },

  {
    name: 'clipboard_set',
    destructive: true,
    description: 'Replace the clipboard text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'New clipboard text.' } },
      required: ['text']
    },
    async handler(args) {
      requireWindows();
      const text = str(args.text);
      runPs(
        `Set-Clipboard -Value $env:RI_TEXT
[pscustomobject]@{ length = $env:RI_TEXT.Length } | ConvertTo-Json -Compress`,
        { env: { RI_TEXT: text }, json: true, timeout: 20000 }
      );
      return `Clipboard set to ${text.length} character(s).`;
    }
  }
];
