# Win32 & UIA Automation library for RiSriGPT Windows automation
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

public class UiaNodeDto {
  public string automation_id;
  public string name;
  public string control_type;
  public string class_name;
  public string value;
  public bool is_offscreen;
  public bool is_enabled;
  public double[] rect;
}

public class UiaResultDto {
  public int count;
  public string text;
  public string error;
  public string hint;
  public List<UiaNodeDto> nodes = new List<UiaNodeDto>();
}

public static class RWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hParent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
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
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);

  public class WinInfo {
    public long Handle;
    public int Pid;
    public string Process;
    public string Title;
    public string ClassName;
    public string State;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Foreground;
    public bool IsDirty;
  }

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;

  public static string TitleOf(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len > 0) {
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      string s = sb.ToString();
      if (!string.IsNullOrEmpty(s)) return s;
    }
    string res = "";
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      int l = GetWindowTextLength(h);
      if (l > 0) {
        var sb = new StringBuilder(l + 2);
        GetWindowText(h, sb, sb.Capacity);
        res = sb.ToString();
      }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return res;
  }

  public static string ClassNameOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    string s = sb.ToString();
    if (!string.IsNullOrEmpty(s)) return s;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      var sb2 = new StringBuilder(256);
      GetClassName(h, sb2, sb2.Capacity);
      s = sb2.ToString();
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return s;
  }

  public static string ProcessOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  public static IntPtr SafeOpenDefaultDesktop() {
    IntPtr h = OpenDesktop("Default", 0, false, 0x01FF);
    if (h == IntPtr.Zero) h = OpenDesktop("Default", 0, false, 0x01C1);
    if (h == IntPtr.Zero) h = OpenDesktop("Default", 0, false, 0x0041);
    return h;
  }

  public static bool CheckDirty(string title) {
    if (string.IsNullOrEmpty(title)) return false;
    string t = title.Trim();
    return t.StartsWith("*") || t.StartsWith("\u2022") || t.StartsWith("\u25cf") || t.Contains(" *") || t.Contains(" [Modified]");
  }

  public static bool CheckDirtyWindow(long handleVal) {
    IntPtr h = new IntPtr(handleVal);
    string title = TitleOf(h);
    if (CheckDirty(title)) return true;
    bool isDirty = false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        uint pid = 0;
        GetWindowThreadProcessId(h, out pid);
        string proc = ProcessOf(pid);
        if (proc.IndexOf("Notepad", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("Notepad", StringComparison.OrdinalIgnoreCase) >= 0) {
          var uia = InspectUia(handleVal, "descendants", new string[] { "TabItem" }, "", 25, false);
          foreach (var n in uia.nodes) {
            if (!string.IsNullOrEmpty(n.name) && n.name.IndexOf("Modified", StringComparison.OrdinalIgnoreCase) >= 0 && n.name.IndexOf("Unmodified", StringComparison.OrdinalIgnoreCase) < 0) {
              isDirty = true;
              return;
            }
          }
          var docUia = InspectUia(handleVal, "descendants", new string[] { "Document", "Edit" }, "", 5, false);
          foreach (var d in docUia.nodes) {
            if (!string.IsNullOrEmpty(d.value) && d.value.Trim().Length > 0) {
              isDirty = true;
              return;
            }
          }
        }
      } catch {}
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return isDirty;
  }

  public static WinInfo[] ListWindows() {
    var list = new List<WinInfo>();
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      long fg = GetForegroundWindow().ToInt64();

      EnumProc proc = delegate (IntPtr h, IntPtr l) {
        if (!IsWindow(h) || !IsWindowVisible(h)) return true;
        if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
        string title = "";
        int len = GetWindowTextLength(h);
        if (len > 0) {
          var sb = new StringBuilder(len + 2);
          GetWindowText(h, sb, sb.Capacity);
          title = sb.ToString();
        }
        if (title.Length == 0) return true;
        string cls = ClassNameOf(h);
        if (cls == "Microsoft.UI.Content.PopupWindowSiteBridge" || title == "PopupHost") return true;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        RECT r;
        GetWindowRect(h, out r);
        var info = new WinInfo();
        info.Handle = h.ToInt64();
        info.Pid = (int)pid;
        info.Process = ProcessOf(pid);
        info.Title = title;
        info.ClassName = cls;
        info.State = IsIconic(h) ? "minimized" : IsZoomed(h) ? "maximized" : "normal";
        info.X = r.Left;
        info.Y = r.Top;
        info.Width = r.Right - r.Left;
        info.Height = r.Bottom - r.Top;
        info.Foreground = (info.Handle == fg);
        info.IsDirty = CheckDirty(title);
        list.Add(info);
        return true;
      };

      EnumWindows(proc, IntPtr.Zero);
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return list.ToArray();
  }

  public static bool IsWindowOnDefault(long handleVal) {
    IntPtr h = new IntPtr(handleVal);
    bool ok = false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      ok = IsWindow(h) && IsWindowVisible(h);
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    if (ok) return true;
    var wins = ListWindows();
    foreach (var w in wins) {
      if (w.Handle == handleVal) return true;
    }
    return false;
  }

  public static IntPtr FindUwpInputChild(IntPtr frame) {
    IntPtr res = IntPtr.Zero;
    EnumChildWindows(frame, delegate (IntPtr h, IntPtr l) {
      string cls = ClassNameOf(h);
      if (cls == "Windows.UI.Core.CoreWindow" || cls.Contains("InputSite")) {
        res = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static long Foreground() {
    long res = 0;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      res = GetForegroundWindow().ToInt64();
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return res;
  }

  public static string ForegroundTitle() {
    long fg = Foreground();
    if (fg == 0) return "";
    return TitleOf(new IntPtr(fg));
  }

  public static bool ForceForeground(IntPtr h) {
    if (!IsWindowOnDefault(h.ToInt64())) return false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    bool ok = false;
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      if (GetForegroundWindow() == h) { ok = true; return; }
      if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      IntPtr fg = GetForegroundWindow();
      uint fgPid, tgtPid;
      uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
      uint tgtThread = GetWindowThreadProcessId(h, out tgtPid);
      uint curThread = GetCurrentThreadId();
      bool attachedFg = false;
      bool attachedTgt = false;
      if (fgThread != 0 && fgThread != curThread) attachedFg = AttachThreadInput(curThread, fgThread, true);
      if (tgtThread != 0 && tgtThread != curThread) attachedTgt = AttachThreadInput(curThread, tgtThread, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      if (attachedTgt) AttachThreadInput(curThread, tgtThread, false);
      if (attachedFg) AttachThreadInput(curThread, fgThread, false);
      ok = (GetForegroundWindow() == h);
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return ok;
  }

  public static bool TryUiaSetText(long handleVal, string text) {
    IntPtr h = new IntPtr(handleVal);
    bool ok = false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        var root = AutomationElement.FromHandle(h);
        if (root == null) return;
        var condDoc = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
        var condEdit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
        var cond = new OrCondition(condDoc, condEdit);
        var doc = root.FindFirst(TreeScope.Descendants, cond);
        if (doc != null) {
          object valPat;
          if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out valPat)) {
            ((ValuePattern)valPat).SetValue(text);
            ok = true;
          }
        }
      } catch {}
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return ok;
  }

  public static void SendKeySequence(string keys) {
    if (string.IsNullOrEmpty(keys)) return;
    int i = 0;
    while (i < keys.Length) {
      if (keys[i] == '^' && i + 1 < keys.Length) {
        i++;
        char k = keys[i];
        short vk = VkKeyScan(k);
        byte vkCode = (byte)(vk & 0xFF);
        keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl down
        keybd_event(vkCode, 0, 0, UIntPtr.Zero);
        keybd_event(vkCode, 0, 2, UIntPtr.Zero);
        keybd_event(0x11, 0, 2, UIntPtr.Zero); // Ctrl up
        Thread.Sleep(50);
        i++;
      } else if (keys[i] == '%' && i + 1 < keys.Length) {
        i++;
        char k = keys[i];
        short vk = VkKeyScan(k);
        byte vkCode = (byte)(vk & 0xFF);
        keybd_event(0x12, 0, 0, UIntPtr.Zero); // Alt down
        keybd_event(vkCode, 0, 0, UIntPtr.Zero);
        keybd_event(vkCode, 0, 2, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt up
        Thread.Sleep(50);
        i++;
      } else if (keys[i] == '{') {
        int end = keys.IndexOf('}', i);
        if (end > i) {
          string tag = keys.Substring(i + 1, end - i - 1).ToUpperInvariant();
          byte vkCode = 0;
          if (tag == "ENTER" || tag == "RETURN") vkCode = 0x0D;
          else if (tag == "TAB") vkCode = 0x09;
          else if (tag == "ESC" || tag == "ESCAPE") vkCode = 0x1B;
          else if (tag == "BACKSPACE" || tag == "BS") vkCode = 0x08;
          else if (tag == "ADD" || tag == "+") vkCode = 0x6B;
          else if (tag == "SUBTRACT" || tag == "-") vkCode = 0x6D;
          else if (tag == "MULTIPLY" || tag == "*") vkCode = 0x6A;
          else if (tag == "DIVIDE" || tag == "/") vkCode = 0x6F;
          int fn;
          if (tag.StartsWith("F") && int.TryParse(tag.Substring(1), out fn)) {
            vkCode = (byte)(0x6F + fn);
          }
          if (vkCode != 0) {
            keybd_event(vkCode, 0, 0, UIntPtr.Zero);
            keybd_event(vkCode, 0, 2, UIntPtr.Zero);
            Thread.Sleep(50);
          }
          i = end + 1;
        } else {
          i++;
        }
      } else {
        char c = keys[i];
        if (c == '+') {
          keybd_event(0x6B, 0, 0, UIntPtr.Zero); // VK_ADD
          keybd_event(0x6B, 0, 2, UIntPtr.Zero);
          Thread.Sleep(50);
        } else {
          short vk = VkKeyScan(c);
          byte vkCode = (byte)(vk & 0xFF);
          byte shift = (byte)((vk >> 8) & 0xFF);
          if ((shift & 1) != 0) keybd_event(0x10, 0, 0, UIntPtr.Zero);
          if ((shift & 2) != 0) keybd_event(0x11, 0, 0, UIntPtr.Zero);
          if ((shift & 4) != 0) keybd_event(0x12, 0, 0, UIntPtr.Zero);

          keybd_event(vkCode, 0, 0, UIntPtr.Zero);
          keybd_event(vkCode, 0, 2, UIntPtr.Zero);

          if ((shift & 4) != 0) keybd_event(0x12, 0, 2, UIntPtr.Zero);
          if ((shift & 2) != 0) keybd_event(0x11, 0, 2, UIntPtr.Zero);
          if ((shift & 1) != 0) keybd_event(0x10, 0, 2, UIntPtr.Zero);
          Thread.Sleep(50);
        }
        i++;
      }
    }
  }

  public static void SendKeysWait(string keys) {
    try {
      SendKeys.SendWait(keys);
    } catch {
      SendKeySequence(keys);
    }
  }

  public static bool TryUiaInvokeCalc(long handleVal, string keys) {
    IntPtr h = new IntPtr(handleVal);
    bool ok = false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        var root = AutomationElement.FromHandle(h);
        if (root == null) return;
        var map = new Dictionary<char, string> {
          { '0', "num0Button" }, { '1', "num1Button" }, { '2', "num2Button" },
          { '3', "num3Button" }, { '4', "num4Button" }, { '5', "num5Button" },
          { '6', "num6Button" }, { '7', "num7Button" }, { '8', "num8Button" },
          { '9', "num9Button" }, { '+', "plusButton" }, { '-', "minusButton" },
          { '*', "multiplyButton" }, { '/', "divideButton" }, { '=', "equalButton" }
        };
        foreach (char c in keys) {
          if (map.ContainsKey(c)) {
            string btnId = map[c];
            var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, btnId);
            var btn = root.FindFirst(TreeScope.Descendants, cond);
            if (btn != null) {
              object invPat;
              if (btn.TryGetCurrentPattern(InvokePattern.Pattern, out invPat)) {
                ((InvokePattern)invPat).Invoke();
                Thread.Sleep(80);
                ok = true;
              }
            }
          }
        }
      } catch {}
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return ok;
  }

  public static bool FocusDocument(long handleVal) {
    IntPtr h = new IntPtr(handleVal);
    bool ok = false;
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        var root = AutomationElement.FromHandle(h);
        if (root == null) return;
        var condDoc = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
        var condEdit = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
        var cond = new OrCondition(condDoc, condEdit);
        var doc = root.FindFirst(TreeScope.Descendants, cond);
        if (doc != null) {
          doc.SetFocus();
          ok = true;
        }
      } catch {}
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return ok;
  }

  public static int[] RectOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return new int[0];
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  public static string ReadValue(AutomationElement el) {
    if (el == null) return null;
    object valPat;
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out valPat)) {
      try { return ((ValuePattern)valPat).Current.Value; } catch {}
    }
    object txtPat;
    if (el.TryGetCurrentPattern(TextPattern.Pattern, out txtPat)) {
      try { return ((TextPattern)txtPat).DocumentRange.GetText(-1); } catch {}
    }
    return null;
  }

  public static UiaResultDto InspectUia(long handleVal, string scopeStr, string[] types, string nameSub, int maxNodes, bool textOnly) {
    var res = new UiaResultDto();
    IntPtr h = new IntPtr(handleVal);
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        if (!IsWindow(h)) {
          res.error = "stale_handle";
          return;
        }
        var root = AutomationElement.FromHandle(h);
        if (root == null) {
          res.error = "stale_handle";
          return;
        }
        var scope = TreeScope.Descendants;
        if (scopeStr == "children") scope = TreeScope.Children;
        else if (scopeStr == "element") scope = TreeScope.Element;

        var setTypes = (types != null && types.Length > 0) ? new HashSet<string>(StringComparer.OrdinalIgnoreCase) : null;
        if (setTypes != null) foreach (var s in types) setTypes.Add(s);

        var list = new List<AutomationElement>();
        if (scope == TreeScope.Element) {
          list.Add(root);
        } else {
          var all = root.FindAll(scope, Condition.TrueCondition);
          for (int i = 0; i < all.Count; i++) list.Add(all[i]);
        }

        var sbText = new StringBuilder();
        foreach (var c in list) {
          if (res.nodes.Count >= maxNodes) break;
          try {
            string ct = c.Current.ControlType != null ? c.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") : "";
            if (setTypes != null && !setTypes.Contains(ct)) continue;
            string name = c.Current.Name ?? "";
            if (!string.IsNullOrEmpty(nameSub) && name.IndexOf(nameSub, StringComparison.OrdinalIgnoreCase) < 0) continue;

            string val = ReadValue(c);
            bool off = c.Current.IsOffscreen;
            bool en = c.Current.IsEnabled;

            if (textOnly) {
              if (!off && (!string.IsNullOrWhiteSpace(name) || !string.IsNullOrWhiteSpace(val))) {
                string s = !string.IsNullOrWhiteSpace(val) ? val : name;
                sbText.AppendLine(s);
                res.count++;
              }
            } else {
              var n = new UiaNodeDto();
              n.automation_id = c.Current.AutomationId ?? "";
              n.name = name;
              n.control_type = ct;
              n.class_name = c.Current.ClassName ?? "";
              n.value = val;
              n.is_offscreen = off;
              n.is_enabled = en;
              var r = c.Current.BoundingRectangle;
              if (r != System.Windows.Rect.Empty) {
                n.rect = new double[] { r.X, r.Y, r.Width, r.Height };
              }
              res.nodes.Add(n);
            }
          } catch {}
        }
        if (textOnly) {
          res.text = sbText.ToString().Trim();
        } else {
          res.count = res.nodes.Count;
        }
      } catch (Exception ex) {
        res.error = ex.Message;
      }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return res;
  }

  public static string ReadCurrentText(long handleVal) {
    IntPtr h = new IntPtr(handleVal);
    if (!IsWindowOnDefault(handleVal)) return "";
    string found = "";
    IntPtr hDesk = SafeOpenDefaultDesktop();
    Thread t = new Thread(() => {
      if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
      try {
        var root = AutomationElement.FromHandle(h);
        if (root == null) return;
        var focused = AutomationElement.FocusedElement;
        if (focused != null) {
          found = ReadValue(focused) ?? focused.Current.Name ?? "";
        }
        if (string.IsNullOrEmpty(found)) {
          var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
          for (int i = 0; i < all.Count; i++) {
            var c = all[i];
            string ct = c.Current.ControlType != null ? c.Current.ControlType.ProgrammaticName : "";
            if (ct.Contains("Document") || ct.Contains("Edit") || ct.Contains("Text")) {
              string v = ReadValue(c) ?? c.Current.Name;
              if (!string.IsNullOrEmpty(v)) { found = v; break; }
            }
          }
        }
      } catch {}
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
    return found;
  }
}
'@ -ReferencedAssemblies "UIAutomationClient", "UIAutomationTypes", "WindowsBase", "System.Windows.Forms"

[RWin]::SetProcessDPIAware() | Out-Null
