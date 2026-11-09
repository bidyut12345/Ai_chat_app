/**
 * Helpers shared by the built-in `windows` automation server.
 *
 * Everything runs through a short PowerShell script. Model-supplied text is
 * handed over in environment variables (never interpolated into the script),
 * so a window title or a typed string cannot break out of the command line.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyError } from './policy.js';

export const IS_WINDOWS = process.platform === 'win32';

const WINLIB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'winlib.ps1').replace(/\\/g, '/');

const PRELUDE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
trap {
  $m = $_.Exception.Message -replace "\\r?\\n", ' '
  if ($m -like '*__RI_JSON_ERROR__*') {
    [Console]::Out.WriteLine($m)
  } else {
    [Console]::Out.WriteLine('__RI_ERROR__' + $m)
  }
  exit 3
}
`;

/**
 * Win32 & UIA entry points loaded from winlib.ps1.
 */
export const WINLIB = `. '${WINLIB_PATH}'\n`;

/** Resolve a model-supplied window reference (handle preferred, else title). */
export const FIND_WINDOW = `function Resolve-Handle {
  param([long]$Handle, [string]$Title)
  if ($Handle -ne 0) {
    if (-not [RWin]::IsWindowOnDefault($Handle)) {
      $cand = @([RWin]::ListWindows() | ForEach-Object { [pscustomobject]@{ handle = $_.Handle; title = $_.Title; pid = $_.Pid; process = $_.Process; class_name = $_.ClassName } })
      $payload = [pscustomobject]@{
        error = 'stale_handle'
        message = 'No window with handle ' + $Handle + ' any more. Run list_windows or find_window to get a fresh handle.'
        stale_handle = $Handle
        candidates = $cand
      } | ConvertTo-Json -Compress
      throw ('__RI_JSON_ERROR__' + $payload)
    }
    return $Handle
  }
  if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Give a window handle (preferred) or a window title.' }
  $all = @([RWin]::ListWindows())
  $exact = @($all | Where-Object { $_.Title -ieq $Title })
  if ($exact.Count -eq 1) { return [long]$exact[0].Handle }
  if ($exact.Count -gt 1) {
    $cand = @($exact | ForEach-Object { [pscustomobject]@{ handle = $_.Handle; title = $_.Title; pid = $_.Pid; process = $_.Process; class_name = $_.ClassName } })
    $payload = [pscustomobject]@{
      error = 'ambiguous_title'
      message = 'Multiple windows match title "' + $Title + '". Specify a unique window handle instead.'
      candidates = $cand
    } | ConvertTo-Json -Compress
    throw ('__RI_JSON_ERROR__' + $payload)
  }
  $partial = @($all | Where-Object { $_.Title -ilike ('*' + $Title + '*') })
  if ($partial.Count -eq 1) { return [long]$partial[0].Handle }
  if ($partial.Count -gt 1) {
    $cand = @($partial | ForEach-Object { [pscustomobject]@{ handle = $_.Handle; title = $_.Title; pid = $_.Pid; process = $_.Process; class_name = $_.ClassName } })
    $payload = [pscustomobject]@{
      error = 'ambiguous_title'
      message = 'Multiple windows match "' + $Title + '". Specify a unique window handle instead.'
      candidates = $cand
    } | ConvertTo-Json -Compress
    throw ('__RI_JSON_ERROR__' + $payload)
  }
  $cand = @($all | ForEach-Object { [pscustomobject]@{ handle = $_.Handle; title = $_.Title; pid = $_.Pid; process = $_.Process; class_name = $_.ClassName } })
  $payload = [pscustomobject]@{
    error = 'no_such_window'
    message = 'No window matching "' + $Title + '". Run list_windows or find_window.'
    candidates = $cand
  } | ConvertTo-Json -Compress
  throw ('__RI_JSON_ERROR__' + $payload)
}
`;

/**
 * Focus a window and prove it worked.
 * Keyboard input goes to whatever window is in front, so a failed focus must
 * stop the call instead of typing into the user's other windows.
 */
export const FOCUS_TARGET = `function Focus-Target {
  param([long]$Handle, [string]$Title, [switch]$AllowUnsaved)
  if ($Handle -eq 0 -and [string]::IsNullOrWhiteSpace($Title)) { return [IntPtr]::Zero }
  $h = [IntPtr](Resolve-Handle -Handle $Handle -Title $Title)

  $titleNow = [RWin]::TitleOf($h)
  if ([string]::IsNullOrEmpty($titleNow)) {
    Start-Sleep -Milliseconds 150
    $titleNow = [RWin]::TitleOf($h)
  }
  $isDirty = [RWin]::CheckDirtyWindow($h.ToInt64())
  if ($isDirty -and -not $AllowUnsaved) {
    $payload = [pscustomobject]@{
      error = 'unsaved_changes'
      message = 'Target window "' + $titleNow + '" has unsaved changes. Refusing to type to prevent destroying user data. Pass allow_unsaved: true to override.'
      handle = $h.ToInt64()
      title = $titleNow
    } | ConvertTo-Json -Compress
    throw ('__RI_JSON_ERROR__' + $payload)
  }

  for ($i = 0; $i -lt 4; $i++) {
    if ([RWin]::ForceForeground($h)) {
      Start-Sleep -Milliseconds 120
      if ([RWin]::Foreground() -eq $h.ToInt64()) { break }
    }
    Start-Sleep -Milliseconds 150
  }
  $fg = [RWin]::Foreground()
  if ($fg -ne $h.ToInt64()) {
    $fgTitle = [RWin]::ForegroundTitle()
    $hTitle = [RWin]::TitleOf($h)
    $sameApp = ($fg -ne 0 -and $fgTitle -and $hTitle -and $fgTitle -ieq $hTitle)
    if (-not $sameApp) {
      $cls = [RWin]::ClassNameOf($h)
      $isChild = $false
      if ($cls -ieq 'ApplicationFrameWindow') {
        $child = [RWin]::FindUwpInputChild($h)
        if ($child -ne [IntPtr]::Zero -and $fg -eq $child.ToInt64()) { $isChild = $true }
      }
      if (-not $isChild) {
        $where = if ($fg -eq 0) {
          'No window has the focus at all, which happens when the desktop is locked or the screen is off.'
        } else {
          'The window in front is "' + $fgTitle + '".'
        }
        throw ('Could not bring "' + $hTitle + '" to the front, so nothing was sent. ' + $where +
          ' Unlock the screen, or ask the user to click the window, then try again.')
      }
    }
  }

  [RWin]::FocusDocument($h.ToInt64()) | Out-Null
  return $h
}
`;

/**
 * PowerShell's encoded-command mode serialises stderr as CLIXML. Turn that
 * back into the plain error lines the user (and the model) can read.
 */
function cleanStderr(raw) {
  const text = String(raw || '');
  if (!text.includes('<Objs')) return text.trim();
  const parts = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/g;
  let m;
  while ((m = re.exec(text))) {
    const line = m[1]
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/_x000D_/g, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .trim();
    if (line) parts.push(line);
  }
  return (parts.length ? parts.join('\n') : text).trim();
}

/**
 * Run a PowerShell script and return its stdout.
 */
export function runPs(script, { env = {}, timeout = 30000, json = false } = {}) {
  if (!IS_WINDOWS) {
    throw new PolicyError('Windows automation is only available on Windows.');
  }
  const full = PRELUDE + script;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...env }
    }
  );
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') throw new PolicyError('The Windows command timed out.');
    throw new PolicyError(`Could not run PowerShell: ${r.error.message}`);
  }
  const stdout = (r.stdout || '').trim();
  const stderr = cleanStderr(r.stderr);

  // Check for structured JSON errors
  const jsonErrors = stdout
    .split(/\r?\n/)
    .concat(stderr.split(/\r?\n/))
    .filter((l) => l.includes('__RI_JSON_ERROR__'))
    .map((l) => l.slice(l.indexOf('__RI_JSON_ERROR__') + '__RI_JSON_ERROR__'.length).trim());
  if (jsonErrors.length) {
    try {
      const data = JSON.parse(jsonErrors[0]);
      const err = new Error(data.message || data.error);
      err.code = data.error;
      err.payload = data;
      throw err;
    } catch (e) {
      if (e.payload) throw e;
    }
  }

  const marked = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('__RI_ERROR__'))
    .map((l) => l.slice('__RI_ERROR__'.length).trim());
  if (marked.length) throw new PolicyError(marked.join('\n'));
  const cleanOut = stdout
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('__RI_ERROR__') && !l.includes('__RI_JSON_ERROR__'))
    .join('\n')
    .trim();
  if (r.status !== 0) {
    const msg = stderr || cleanOut || `PowerShell exited with code ${r.status}`;
    const lines = msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const keep = lines.filter((l) => !/^(At line:|CategoryInfo|FullyQualifiedErrorId|\+|~~~)/.test(l));
    throw new PolicyError((keep.length ? keep : lines).slice(0, 6).join('\n'));
  }
  if (json) {
    try {
      return JSON.parse(cleanOut);
    } catch {
      throw new PolicyError(`Unexpected output from PowerShell: ${cleanOut.slice(0, 400) || '(empty)'}`);
    }
  }
  return cleanOut;
}

/** Run a script that prints one JSON object per line; returns the parsed rows. */
export function runPsLines(script, opts = {}) {
  const out = runPs(script, opts);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
