' ============================================================
'  Starts the Local AI Chat server with NO console window at all.
'  Output goes to logs\server.log. Stop it with stop-server.bat.
'  Usage: cscript //nologo start-server-hidden.vbs [port]
' ============================================================
Option Explicit

Dim sh, fso, appDir, port
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
port = "3000"
If WScript.Arguments.Count > 0 Then port = Trim(WScript.Arguments(0))

If Not fso.FolderExists(appDir & "\logs") Then fso.CreateFolder(appDir & "\logs")

' sh.Run window style 0 = hidden; the child gets its own console, so it
' keeps running after the window that launched this script is closed.
sh.CurrentDirectory = appDir
sh.Run "cmd /c set ""NODE_ENV=production"" && set ""HOST=0.0.0.0"" && set ""PORT=" & port & """ && node server\index.js >> logs\server.log 2>&1", 0, False
