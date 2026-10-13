Option Explicit
Dim fso, shell, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\stop-bridge.ps1"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
