$root = $PSScriptRoot
if ($env:TERM_PROGRAM -eq "vscode") {
    Start-Sleep -Milliseconds 150
    (New-Object -ComObject WScript.Shell).SendKeys("^+b")
    Write-Host "Dang chia doi Terminal trong VS Code cho Backend (8000) & Frontend (3000)..."
} else {
    $beCmd = "..\.venv\Scripts\python.exe -m uvicorn app.sever:app --host 127.0.0.1 --port 8000 --reload"
    $feCmd = "npm run dev"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = 'ViRead Backend (8000)'; Set-Location '$root\backend'; $beCmd"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = 'ViRead Frontend (3000)'; Set-Location '$root\frontend'; $feCmd"
    Write-Host "Da khoi dong Backend (8000) & Frontend (3000)!"
}