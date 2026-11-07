[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipOllama
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RepoRoot 'backend'
$FrontendDir = Join-Path $RepoRoot 'frontend'
$VenvDir = Join-Path $BackendDir '.venv'
$BackendRequirements = Join-Path $RepoRoot 'requirements.txt'
$OllamaPinnedVersion = [version]'0.40.15'
$OllamaMinimumVersion = [version]'0.12.7'
$OllamaInstallerUrl = 'https://github.com/ollama/ollama/releases/download/v0.40.15/OllamaSetup.exe'
$OllamaInstallerSha256 = '106ef3d2a02437810fba6f574914b1413c512ea84ddd4f184c8e7f434b6f5564'
$OllamaModel = 'qwen3-vl:4b-instruct-q4_K_M'
$TessdataCommit = '87416418657359cb625c412a48b6e1d6d41c29bd'
$TessdataHashes = @{
    'vie' = '79df64caf7bcfb2a27df5042ecb6121e196eada34da774956995747636d5bfa1'
    'eng' = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
    'osd' = '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff'
}

function Stop-Setup([string]$Message) {
    throw $Message
}

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Get-PythonLauncher {
    $py = Get-CommandPath 'py.exe'
    if ($py) {
        & $py -3.12 --version *> $null
        if ($LASTEXITCODE -eq 0) { return @{ Path = $py; Prefix = @('-3.12') } }
    }

    $python = Get-CommandPath 'python.exe'
    if ($python) {
        $versionText = (& $python --version 2>&1 | Out-String).Trim()
        if ($versionText -match '^Python 3\.12\.') { return @{ Path = $python; Prefix = @() } }
    }

    Stop-Setup 'Cần cài Python 3.12 x64 trước khi chạy script. Tải Python từ https://www.python.org/downloads/windows/ rồi mở PowerShell mới.'
}

function Get-NodeRuntime {
    $node = Get-CommandPath 'node.exe'
    $npm = Get-CommandPath 'npm.cmd'
    if (-not $node -or -not $npm) {
        Stop-Setup 'Cần cài Node.js 22.13 trở lên (kèm npm) trước khi chạy script.'
    }

    $nodeText = (& $node --version 2>&1 | Out-String).Trim().TrimStart('v')
    $npmText = (& $npm --version 2>&1 | Out-String).Trim()
    try {
        $nodeVersion = [version]$nodeText
        $npmVersion = [version]$npmText
    } catch {
        Stop-Setup 'Không đọc được phiên bản Node.js/npm. Hãy cài lại Node.js 22.13 trở lên rồi mở PowerShell mới.'
    }

    if ($nodeVersion -lt [version]'22.13.0') {
        Stop-Setup "Node.js $nodeVersion quá cũ; cần 22.13 trở lên."
    }
    if ($npmVersion -lt [version]'10.9.3') {
        Stop-Setup "npm $npmVersion quá cũ; cần 10.9.3 trở lên."
    }

    return @{ Node = $node; Npm = $npm; Version = $nodeVersion }
}

function Get-OllamaExecutable {
    $command = Get-CommandPath 'ollama.exe'
    if ($command) { return $command }

    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return $null
}

function Get-OllamaVersion([string]$Executable) {
    if (-not $Executable) { return $null }
    $versionText = (& $Executable --version 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(\d+\.\d+\.\d+)') { return $null }
    return [version]$Matches[1]
}

function Add-OllamaToSessionPath([string]$Executable) {
    $directory = Split-Path -Parent $Executable
    $present = $env:PATH -split ';' | Where-Object { $_.TrimEnd('\') -ieq $directory.TrimEnd('\') }
    if (-not $present) { $env:PATH = "$directory;$env:PATH" }
}

function Get-TesseractExecutable {
    $command = Get-CommandPath 'tesseract.exe'
    if ($command) { return $command }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'Tesseract-OCR\tesseract.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Tesseract-OCR\tesseract.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($candidates) { return $candidates[0] }
    return $null
}

function Get-TesseractLanguages([string]$Executable) {
    $output = (& $Executable --list-langs 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { return @() }
    return @([regex]::Matches($output, '(?m)^\s*([a-z][a-z0-9_]+)\s*$') | ForEach-Object { $_.Groups[1].Value })
}

function Ensure-VietnameseTessdata([string]$Executable) {
    $languages = Get-TesseractLanguages $Executable
    $localDataDir = Join-Path $BackendDir 'tessdata'
    $localVietnameseData = Join-Path $localDataDir 'vie.traineddata'

    if (Test-Path -LiteralPath $localVietnameseData -PathType Leaf) {
        $env:TESSDATA_PREFIX = $BackendDir
        $languages = Get-TesseractLanguages $Executable
    }

    if ($languages -contains 'vie') { return }
    if ($CheckOnly) {
        Stop-Setup 'Tesseract chưa có dữ liệu tiếng Việt. Chạy lại requirements.ps1 để tải mô hình OCR tiếng Việt vào backend\tessdata.'
    }

    New-Item -ItemType Directory -Path $localDataDir -Force | Out-Null
    foreach ($language in @('vie', 'eng', 'osd')) {
        $destination = Join-Path $localDataDir "$language.traineddata"
        $expectedHash = $TessdataHashes[$language]
        $alreadyValid = (Test-Path -LiteralPath $destination -PathType Leaf) -and
            ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash)

        if (-not $alreadyValid) {
            $url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$TessdataCommit/$language.traineddata"
            Write-Host "Đang tải dữ liệu OCR tiếng Việt (nguồn cố định: tessdata_fast/$TessdataCommit)..."
            Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
        }

        $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            Remove-Item -LiteralPath $destination -Force
            Stop-Setup "Kiểm tra toàn vẹn dữ liệu Tesseract $language thất bại; file tải về đã bị xóa."
        }
    }

    $env:TESSDATA_PREFIX = $BackendDir
    if ((Get-TesseractLanguages $Executable) -notcontains 'vie') {
        Stop-Setup 'Đã tải dữ liệu OCR nhưng Tesseract chưa nhận ra tiếng Việt. Kiểm tra phiên bản Tesseract 5.x.'
    }
}

function Ensure-Tesseract {
    $executable = Get-TesseractExecutable
    if (-not $executable -and -not $CheckOnly) {
        $winget = Get-CommandPath 'winget.exe'
        if (-not $winget) {
            Stop-Setup 'Chưa có Tesseract 5.x và không tìm thấy winget. Cài Tesseract từ https://github.com/UB-Mannheim/tesseract/wiki rồi chạy lại script.'
        }

        Write-Host 'Đang cài Tesseract OCR 5.x từ gói UB Mannheim qua winget...'
        & $winget install --id UB-Mannheim.TesseractOCR --exact --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { Stop-Setup 'winget không cài được Tesseract. Hãy cài Tesseract 5.x rồi chạy lại script.' }
        $executable = Get-TesseractExecutable
    }
    if (-not $executable) { Stop-Setup 'Không tìm thấy Tesseract OCR 5.x.' }

    $versionText = (& $executable --version 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(?m)^tesseract\s+v?(\d+)\.') {
        Stop-Setup 'Không thể xác minh phiên bản Tesseract.'
    }
    if ([int]$Matches[1] -lt 5) { Stop-Setup 'Cần Tesseract 5.x trở lên.' }
    Ensure-VietnameseTessdata $executable
    return $executable
}

function Test-OllamaApi {
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Ensure-Ollama {
    if ($SkipOllama) {
        Write-Warning 'Đã bỏ qua Ollama theo -SkipOllama; chức năng sửa AI cục bộ sẽ chưa chạy được.'
        return
    }

    $executable = Get-OllamaExecutable
    $installedVersion = Get-OllamaVersion $executable
    if (-not $installedVersion -or $installedVersion -lt $OllamaMinimumVersion) {
        if ($CheckOnly) {
            Stop-Setup "Ollama $OllamaMinimumVersion trở lên chưa được cài. Chạy requirements.ps1 để cài Ollama và tải model AI cục bộ."
        }

        $installerPath = Join-Path ([IO.Path]::GetTempPath()) "ViRead-OllamaSetup-$OllamaPinnedVersion.exe"
        Write-Host "Đang tải Ollama $OllamaPinnedVersion từ GitHub release chính thức (file khoảng 1.6 GB)..."
        Invoke-WebRequest -Uri $OllamaInstallerUrl -OutFile $installerPath -UseBasicParsing
        $installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($installerHash -ne $OllamaInstallerSha256) {
            Remove-Item -LiteralPath $installerPath -Force
            Stop-Setup 'Kiểm tra chữ ký SHA-256 của bộ cài Ollama thất bại; file tải về đã bị xóa.'
        }

        $installer = Start-Process -FilePath $installerPath -ArgumentList @('/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES') -Wait -PassThru -WindowStyle Hidden
        Remove-Item -LiteralPath $installerPath -Force
        if ($installer.ExitCode -ne 0) { Stop-Setup "Bộ cài Ollama kết thúc với mã $($installer.ExitCode)." }

        $executable = Get-OllamaExecutable
        if (-not $executable) {
            $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $executable = $candidate }
        }
        $installedVersion = Get-OllamaVersion $executable
        if (-not $executable -or -not $installedVersion) { Stop-Setup 'Cài Ollama xong nhưng chưa tìm thấy ollama.exe.' }
    }

    Add-OllamaToSessionPath $executable
    if ($installedVersion -lt $OllamaMinimumVersion) {
        Stop-Setup "Phiên bản Ollama $installedVersion không hỗ trợ model $OllamaModel."
    }

    if (-not (Test-OllamaApi)) {
        if ($CheckOnly) { Stop-Setup 'Ollama đã cài nhưng API cục bộ 127.0.0.1:11434 chưa chạy.' }
        Write-Host 'Đang khởi chạy dịch vụ Ollama chỉ trên máy cục bộ...'
        Start-Process -FilePath $executable -ArgumentList 'serve' -WindowStyle Hidden
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Seconds 2
            if (Test-OllamaApi) { $ready = $true; break }
        }
        if (-not $ready) { Stop-Setup 'Ollama chưa mở API cục bộ sau 120 giây.' }
    }

    $models = (Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5).models
    $modelExists = @($models | Where-Object { $_.name -eq $OllamaModel }).Count -gt 0
    if (-not $modelExists) {
        if ($CheckOnly) { Stop-Setup "Chưa tải model $OllamaModel. Chạy requirements.ps1 để tải model cục bộ (~3.3 GB)." }
        Write-Host "Đang tải model $OllamaModel (~3.3 GB) từ Ollama Library; không gửi nội dung OCR lên dịch vụ AI đám mây..."
        & $executable pull $OllamaModel
        if ($LASTEXITCODE -ne 0) { Stop-Setup "Không tải được model $OllamaModel." }
    }

    Write-Host "Ollama $installedVersion và model $OllamaModel đã sẵn sàng trên máy này."
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup 'Project cần Windows 64-bit để cài bộ OCR.' }
    $python = Get-PythonLauncher
    $node = Get-NodeRuntime

    Write-Host "Python 3.12 và Node.js $($node.Version) đã được tìm thấy."
    $tesseract = Ensure-Tesseract
    $tesseractVersion = (& $tesseract --version 2>&1 | Select-Object -First 1)
    Write-Host "$tesseractVersion; có dữ liệu tiếng Việt."
    Ensure-Ollama

    if ($CheckOnly) {
        if (-not (Test-Path -LiteralPath (Join-Path $VenvDir 'Scripts\python.exe'))) {
            Stop-Setup 'Chưa tạo môi trường Python backend. Bỏ -CheckOnly để cài dependencies.'
        }
        Write-Host 'Kiểm tra cài đặt thành công; không có package nào bị cài hoặc cập nhật.'
        exit 0
    }

    $backendPython = Join-Path $VenvDir 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $backendPython)) {
        Write-Host 'Đang tạo môi trường Python riêng cho Backend...'
        & $python.Path @($python.Prefix) -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { Stop-Setup 'Không tạo được backend\.venv.' }
    }

    Write-Host 'Đang cài toàn bộ thư viện Python đã ghim phiên bản...'
    & $backendPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Không cập nhật được pip trong backend\.venv.' }
    & $backendPython -m pip install --requirement $BackendRequirements
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Không cài được backend Python requirements.' }

    Write-Host 'Đang cài đúng frontend packages từ package-lock.json...'
    Push-Location $FrontendDir
    try {
        & $node.Npm ci
        if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm ci thất bại.' }
    } finally {
        Pop-Location
    }

    $backendEnv = Join-Path $BackendDir '.env'
    $frontendEnv = Join-Path $FrontendDir '.env.local'
    if (-not (Test-Path -LiteralPath $backendEnv)) {
        Copy-Item -LiteralPath (Join-Path $BackendDir '.env.example') -Destination $backendEnv
        Write-Host 'Đã tạo backend\.env từ mẫu; cần tự điền thông tin Supabase/Database của môi trường dev.'
    } else {
        Write-Host 'Giữ nguyên backend\.env hiện có.'
    }
    if (-not (Test-Path -LiteralPath $frontendEnv)) {
        Copy-Item -LiteralPath (Join-Path $FrontendDir '.env.example') -Destination $frontendEnv
        Write-Host 'Đã tạo frontend\.env.local từ mẫu; cần điền Supabase URL và publishable key.'
    } else {
        Write-Host 'Giữ nguyên frontend\.env.local hiện có.'
    }

    Write-Host ''
    Write-Host 'Cài đặt dependencies hoàn tất. File .env được giữ local và không ghi đè.'
    Write-Host 'Sau khi điền thông tin môi trường dev, xem README để chạy Backend ở cổng 8000 và Frontend ở cổng 3000.'
} catch {
    Write-Error $_
    exit 1
}
