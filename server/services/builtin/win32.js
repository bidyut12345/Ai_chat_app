/**
 * Helpers shared by the built-in `windows` automation server.
 *
 * Everything runs through a short PowerShell script. Model-supplied text is
 * handed over in environment variables (never interpolated into the script),
 * so a window title or a typed string cannot break out of the command line.
 */
import { spawnSync } from 'node:child_process';
import { PolicyError } from './policy.js';

export const IS_WINDOWS = process.platform === 'win32';

const PRELUDE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
# One line, on stdout: PowerShell's own stderr arrives as wrapped CLIXML.
trap {
  $m = $_.Exception.Message -replace "\\r?\\n", ' '
  [Console]::Out.WriteLine('__RI_ERROR__' + $m)
  exit 3
}
`;

/**
 * Win32 entry points used by the window / screen / mouse tools. Declared once
 * per script because each call is a fresh PowerShell process.
 *
 * Windows are enumerated with EnumWindows rather than through
 * `Get-Process.MainWindowHandle`: the process property only reports one window
 * per process and drops it for store apps and for windows that stop being the
 * "main" one, which made handles go stale mid-task.
 */
export const WINLIB = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class RWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);

  public class WinInfo {
    public long Handle;
    public int Pid;
    public string Process;
    public string Title;
    public string State;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Foreground;
  }

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;

  public static string TitleOf(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string ProcessOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // Every visible top-level window that has a title and is not a tool window.
  public static WinInfo[] ListWindows() {
    var list = new List<WinInfo>();
    long fg = GetForegroundWindow().ToInt64();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
      string title = TitleOf(h);
      if (title.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      RECT r;
      GetWindowRect(h, out r);
      var info = new WinInfo();
      info.Handle = h.ToInt64();
      info.Pid = (int)pid;
      info.Process = ProcessOf(pid);
      info.Title = title;
      info.State = IsIconic(h) ? "minimized" : IsZoomed(h) ? "maximized" : "normal";
      info.X = r.Left;
      info.Y = r.Top;
      info.Width = r.Right - r.Left;
      info.Height = r.Bottom - r.Top;
      info.Foreground = (info.Handle == fg);
      list.Add(info);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // Windows only lets the foreground app raise another window; a background
  // process is silently ignored. Restore the window, borrow the foreground
  // thread's input queue, and if the foreground lock still holds, tap ALT once
  // (which releases it) before asking again.
  public static bool ForceForeground(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    ShowWindow(h, IsIconic(h) ? 9 : 5);
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint tgtPid;
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint tgtThread = GetWindowThreadProcessId(h, out tgtPid);
    bool attached = false;
    if (fgThread != tgtThread) attached = AttachThreadInput(fgThread, tgtThread, true);
    BringWindowToTop(h);
    SetActiveWindow(h);
    SetFocus(h);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(fgThread, tgtThread, false);
    if (ok && GetForegroundWindow() == h) return true;

    keybd_event(0x12, 0, 0, UIntPtr.Zero); // ALT down
    keybd_event(0x12, 0, 2, UIntPtr.Zero); // ALT up
    SwitchToThisWindow(h, true);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }

  public static int[] RectOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return new int[0];
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static string ForegroundTitle() { return TitleOf(GetForegroundWindow()); }
}
'@
[RWin]::SetProcessDPIAware() | Out-Null
`;

/** Resolve a model-supplied window reference (handle preferred, else title). */
export const FIND_WINDOW = `function Resolve-Handle {
  param([long]$Handle, [string]$Title)
  if ($Handle -ne 0) {
    if (-not [RWin]::IsWindow([IntPtr]$Handle)) {
      throw ('No window with handle ' + $Handle + ' any more. Run list_windows to get a fresh handle.')
    }
    return $Handle
  }
  if ([string]::IsNullOrWhiteSpace($Title)) { throw 'Give a window title or a window handle.' }
  $all = @([RWin]::ListWindows())
  $exact = $all | Where-Object { $_.Title -ieq $Title } | Select-Object -First 1
  if ($exact) { return [long]$exact.Handle }
  $partial = $all | Where-Object { $_.Title -ilike ('*' + $Title + '*') } | Select-Object -First 1
  if ($partial) { return [long]$partial.Handle }
  $names = ($all | ForEach-Object { $_.Title }) -join ' | '
  throw ('No window matching "' + $Title + '". Open windows: ' + $names)
}
`;

/**
 * Focus a window and prove it worked.
 *
 * Keyboard input goes to whatever window is in front, so a failed focus must
 * stop the call instead of typing into the user's other windows.
 */
export const FOCUS_TARGET = `function Focus-Target {
  param([long]$Handle, [string]$Title)
  if ($Handle -eq 0 -and [string]::IsNullOrWhiteSpace($Title)) { return [IntPtr]::Zero }
  $h = [IntPtr](Resolve-Handle -Handle $Handle -Title $Title)
  for ($i = 0; $i -lt 4; $i++) {
    if ([RWin]::ForceForeground($h)) {
      Start-Sleep -Milliseconds 120
      if ([RWin]::Foreground() -eq $h.ToInt64()) { return $h }
    }
    Start-Sleep -Milliseconds 150
  }
  $fg = [RWin]::Foreground()
  $where = if ($fg -eq 0) {
    'No window has the focus at all, which happens when the desktop is locked or the screen is off.'
  } else {
    'The window in front is "' + [RWin]::ForegroundTitle() + '".'
  }
  throw ('Could not bring "' + [RWin]::TitleOf($h) + '" to the front, so nothing was sent. ' + $where +
    ' Unlock the screen, or ask the user to click the window, then try again.')
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
 *
 * The script travels as `-EncodedCommand` (base64 UTF-16LE), so multi-line
 * blocks and here-strings survive intact and nothing can leak into the command
 * line. Throws a PolicyError carrying the script's error message on failure.
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
  const marked = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('__RI_ERROR__'))
    .map((l) => l.slice('__RI_ERROR__'.length).trim());
  if (marked.length) throw new PolicyError(marked.join('\n'));
  const cleanOut = stdout
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('__RI_ERROR__'))
    .join('\n')
    .trim();
  if (r.status !== 0) {
    const msg = stderr || cleanOut || `PowerShell exited with code ${r.status}`;
    // Keep the message and the offending line, drop the PowerShell call-site noise.
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
