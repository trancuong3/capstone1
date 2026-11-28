Option Explicit

Dim shell, fso, scriptDir, psScript, respectStop, i, arg, psCommand
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

psScript = "F:\c1\tools\ocr-runtime\Run-ViReadOcrWorkerAutostart.ps1"
If Not fso.FileExists(psScript) Then
    scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
    psScript = fso.BuildPath(scriptDir, "Run-ViReadOcrWorkerAutostart.ps1")
End If

respectStop = False
For i = 0 To WScript.Arguments.Count - 1
    arg = LCase(Trim(WScript.Arguments(i)))
    If arg = "--respect-stop" Or arg = "-respectstopsentinel" Then
        respectStop = True
    End If
Next

psCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
If respectStop Then
    psCommand = psCommand & " -RespectStopSentinel"
End If

shell.Run psCommand, 0, False

Set fso = Nothing
Set shell = Nothing
