' (c) 2026 Mathew. All rights reserved.
' Launches the Zarya voice server hidden (no console window).
' Place a shortcut to this file in shell:startup to run it at logon.
' If the server is already running, the new instance fails to bind the port and exits quietly.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = here
shell.Run """" & here & "\venv\Scripts\pythonw.exe"" """ & here & "\zarya_server.py""", 0, False
