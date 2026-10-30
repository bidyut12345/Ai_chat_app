/**
 * Built-in MCP server: `windows` (Windows desktop automation).
 *
 * Window management, launching apps, keyboard / mouse input, clipboard and
 * screenshots. Every tool runs a short PowerShell script; the model's text
 * travels in environment variables, so it is never spliced into the script.
 *
 * Screenshots are saved into the chat's working folder and the path is
 * returned — the tool result itself stays text, so the model does not receive
 * the pixels.
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
      'List the visible top-level windows: handle, process, title, state and position. Use the handle (or a distinctive part of the title) with focus_window, window_action and screenshot.',
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
    state = $w.State
    x = $w.X
    y = $w.Y
    width = $w.Width
    height = $w.Height
    foreground = $w.Foreground
  } | ConvertTo-Json -Compress
}`,
        { timeout: 45000 }
      );
      const f = str(args.filter).trim().toLowerCase();
      const kept = f ? rows.filter((r) => `${r.title} ${r.process}`.toLowerCase().includes(f)) : rows;
      if (!kept.length) return f ? `No window matches "${args.filter}".` : 'No visible windows.';
      kept.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      const lines = kept.map((r) => {
        const size = `${r.width}x${r.height} at ${r.x},${r.y}`;
        const mark = r.foreground ? '  [focused]' : '';
        return `handle ${r.handle}  pid ${r.pid}  ${r.process}  ${stateOf(r.state)}  ${size}  ${r.title}${mark}`;
      });
      return `${kept.length} window(s):\n${lines.join('\n')}`;
    }
  },

  {
    name: 'focus_window',
    destructive: true,
    description: 'Bring a window to the front so it receives keyboard and mouse input. Match it by handle (preferred) or by part of its title.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'number', description: 'Window handle from list_windows.' },
        title: { type: 'string', description: 'Window title, or a distinctive part of it.' }
      }
    },
    async handler(args) {
      requireWindows();
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      if (!handle && !title) throw new PolicyError('Give a window handle or a title.');
      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE
[pscustomobject]@{ handle = $h.ToInt64(); title = [RWin]::TitleOf($h) } | ConvertTo-Json -Compress`,
        { env: { RI_HANDLE: String(handle), RI_TITLE: title }, json: true, timeout: 30000 }
      );
      return `Focused "${res.title}"  handle ${res.handle}`;
    }
  },

  {
    name: 'window_action',
    destructive: true,
    description:
      'Change one window: minimize, maximize, restore, close, move to x/y, or resize to width/height. Match the window by handle (preferred) or part of its title.',
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
      'Start a program, open a document or open a URL with its default handler. When the new program shows a window, its handle is returned so you can type into it straight away. Use the shell tools for commands that should run in a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Executable path, document path or URL.' },
        arguments: { type: 'string', description: 'Command line arguments for the program, as one string.' },
        working_dir: { type: 'string', description: 'Working directory for the new process.' }
      },
      required: ['target']
    },
    async handler(args) {
      requireWindows();
      const target = str(args.target).trim();
      if (!target) throw new PolicyError('target is required.');
      const cwd = args.working_dir ? resolveCwd(args.working_dir) : '';
      const res = runPs(
        `${WINLIB}
$before = @([RWin]::ListWindows() | ForEach-Object { $_.Handle })
$start = @{ FilePath = $env:RI_TARGET; PassThru = $true }
if ($env:RI_ARGS) { $start['ArgumentList'] = $env:RI_ARGS }
if ($env:RI_CWD) { $start['WorkingDirectory'] = $env:RI_CWD }
$p = Start-Process @start
$deadline = (Get-Date).AddSeconds(8)
$exe = [System.IO.Path]::GetFileNameWithoutExtension($env:RI_TARGET)
$found = $null
$fallback = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $new = @([RWin]::ListWindows() | Where-Object { $before -notcontains $_.Handle })
  if ($new.Count -gt 0) {
    # A console window belongs to conhost, not to the program: accept any new
    # window whose title mentions the program we started.
    if (-not $fallback) {
      $fallback = $new | Where-Object { $exe -and $_.Title -ilike ('*' + $exe + '*') } | Select-Object -First 1
    }
    $mine = $new | Where-Object { $p -and $_.Pid -eq $p.Id } | Select-Object -First 1
    if ($mine) { $found = $mine; break }
  }
  if ($p -and $p.HasExited) { break }
}
$matched = $true
if (-not $found) { $found = $fallback; $matched = $false }
[pscustomobject]@{
  pid = $(if ($p) { $p.Id } else { $null })
  process = $(if ($p) { $p.ProcessName } else { $null })
  target = $env:RI_TARGET
  handle = $(if ($found) { $found.Handle } else { 0 })
  title = $(if ($found) { $found.Title } else { '' })
  window_pid = $(if ($found) { $found.Pid } else { 0 })
  matched = $matched
  exited = $(if ($p) { [bool]$p.HasExited } else { $true })
} | ConvertTo-Json -Compress`,
        { env: { RI_TARGET: target, RI_ARGS: str(args.arguments), RI_CWD: cwd }, json: true, timeout: 30000 }
      );
      const procName = res.process || res.target || 'app';
      if (res.handle) {
        const owner = res.matched ? '' : ' (its window belongs to another process, e.g. a console host)';
        return `Started ${procName} (pid ${res.pid}) for ${res.target}\nWindow: "${res.title}"  handle ${res.handle}${owner}`;
      }
      if (res.pid && !res.exited) {
        return `Started ${procName} (pid ${res.pid}) for ${res.target}. It has no window yet — use list_windows to find it.`;
      }
      return `Opened ${res.target} with its default handler (no new window of its own — use list_windows).`;
    }
  },

  {
    name: 'screenshot',
    readOnly: true,
    description:
      'Save a PNG of the whole primary screen (or of one window) into the chat folder and return its path and size. Open the path yourself to look at it; the tool result is text only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to save the PNG, relative to the chat folder. Defaults to screenshot-<timestamp>.png.' },
        handle: { type: 'number', description: 'Capture only this window (handle from list_windows). Omit for the whole screen.' }
      }
    },
    async handler(args) {
      requireWindows();
      const rel = str(args.path).trim() || `screenshot-${stamp()}.png`;
      const abs = resolvePath(rel, { mustExist: false });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const handle = Number(args.handle) || 0;
      const res = runPs(
        `${WINLIB}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$h = [long]$env:RI_HANDLE
if ($h -ne 0) {
  if (-not [RWin]::IsWindow([IntPtr]$h)) { throw ('No window with handle ' + $h + ' any more. Run list_windows to get a fresh handle.') }
  if ([RWin]::IsIconic([IntPtr]$h)) { throw 'That window is minimized, so there is nothing on screen to capture. Restore it first.' }
  $rect = [RWin]::RectOf([IntPtr]$h)
  if ($rect.Length -lt 4) { throw 'Could not read that window''s screen rectangle (it may be minimized or on another desktop).' }
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
$bmp.Save($env:RI_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[pscustomobject]@{ path = $env:RI_PATH; width = $w; height = $ht } | ConvertTo-Json -Compress`,
        { env: { RI_PATH: abs, RI_HANDLE: String(handle) }, json: true, timeout: 30000 }
      );
      const bytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
      return `Saved ${res.width}x${res.height} PNG (${bytes} bytes)\n${res.path}${handle ? `\nwindow handle ${handle}` : ''}`;
    }
  },

  {
    name: 'send_keys',
    destructive: true,
    description:
      'Send keystrokes to a window (or to whatever has focus) using SendKeys syntax: ^s = Ctrl+S, %{F4} = Alt+F4, {ENTER}, {TAB}, {ESC}. Use type_text for ordinary text.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'SendKeys string, e.g. "^s" or "{ENTER}".' },
        handle: { type: 'number', description: 'Focus this window first (handle from list_windows).' },
        title: { type: 'string', description: 'Focus the window with this title first.' }
      },
      required: ['keys']
    },
    async handler(args) {
      requireWindows();
      const keys = str(args.keys);
      if (!keys) throw new PolicyError('keys is required.');
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
Add-Type -AssemblyName System.Windows.Forms
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE
[System.Windows.Forms.SendKeys]::SendWait($env:RI_KEYS)
$name = if ($h -eq [IntPtr]::Zero) { [RWin]::ForegroundTitle() } else { [RWin]::TitleOf($h) }
[pscustomobject]@{ title = $name } | ConvertTo-Json -Compress`,
        { env: { RI_KEYS: keys, RI_HANDLE: String(handle), RI_TITLE: title }, json: true, timeout: 30000 }
      );
      return `Sent ${keys.length} character(s) of keystrokes to "${res.title}".`;
    }
  },

  {
    name: 'type_text',
    destructive: true,
    description:
      'Type literal text into the focused window (or focus a window first). Newlines become Enter. Special characters are escaped for you, so this is the safe way to type a sentence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        handle: { type: 'number', description: 'Focus this window first (handle from list_windows).' },
        title: { type: 'string', description: 'Focus the window with this title first.' }
      },
      required: ['text']
    },
    async handler(args) {
      requireWindows();
      const text = str(args.text);
      if (!text) throw new PolicyError('text is required.');
      const handle = Number(args.handle) || 0;
      const title = str(args.title).trim();
      const res = runPs(
        `${WINLIB}${FIND_WINDOW}${FOCUS_TARGET}
Add-Type -AssemblyName System.Windows.Forms
$h = Focus-Target -Handle ([long]$env:RI_HANDLE) -Title $env:RI_TITLE
[System.Windows.Forms.SendKeys]::SendWait($env:RI_KEYS)
$name = if ($h -eq [IntPtr]::Zero) { [RWin]::ForegroundTitle() } else { [RWin]::TitleOf($h) }
[pscustomobject]@{ title = $name } | ConvertTo-Json -Compress`,
        { env: { RI_KEYS: sendKeysLiteral(text), RI_HANDLE: String(handle), RI_TITLE: title }, json: true, timeout: 30000 }
      );
      return `Typed ${text.length} character(s) into "${res.title}".`;
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
