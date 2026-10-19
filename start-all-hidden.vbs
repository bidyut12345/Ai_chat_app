' ============================================================
'  Silent launcher for the boot task (and the Startup folder).
'  Runs start-all.bat with no window at all:
'    model server on 8080 -> chat app on 3000 (both on the LAN)
' ============================================================
Option Explicit

Dim sh, fso, appDir, bat
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = appDir & "\start-all.bat"

If Not fso.FileExists(bat) Then
  WScript.Quit 1
End If

If Not fso.FolderExists(appDir & "\logs") Then fso.CreateFolder(appDir & "\logs")

Dim ok, exe
On Error Resume Next
exe = Trim(sh.Exec("cmd /c where node").StdOut.ReadLine)
ok = (Err.Number = 0 And Len(exe) > 0)
On Error GoTo 0

If Not ok Then
  Dim f
  Set f = fso.CreateTextFile(appDir & "\logs\startup-error.log", True)
  f.WriteLine Now() & " - node was not found on PATH. Install Node.js 22+ or add it to PATH."
  f.Close
  WScript.Quit 1
End If

' 0 = hidden window, False = do not wait
sh.CurrentDirectory = appDir
sh.Run """" & bat & """", 0, False