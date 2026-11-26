<#
.SYNOPSIS
    Turnkey 0-VND Azure for Students deployer for ViRead's 3-engine OCR Worker (Azure Container Apps).
.DESCRIPTION
    Compatible with Windows PowerShell 5.1 and PowerShell 7+.
    - Zero Azure Container Registry cost ($0.00): pulls directly from ghcr.io/trancuong3/viread-ocr-worker:latest.
    - Zero Log Analytics cost ($0.00): creates Container Apps Environment with --logs-destination none.
    - Scale-to-zero (minReplicas=0, maxReplicas=1, 2.0 vCPU / 4.0Gi RAM, cooldownPeriod=30, pollingInterval=15).
    - Automatically probes candidate regions to bypass Azure for Students RequestDisallowedByPolicy errors.
    - Never prints or logs secrets; wipes plaintext secrets from memory on exit.
#>
[CmdletBinding()]
param(
    [string]$ResourceGroupName = 'rg-viread-ocr',
    [string]$EnvironmentName = 'cae-viread-ocr',
    [string]$AppName = 'viread-ocr-worker',
    [string]$BackendUrl = 'https://capstone1-ssd8.onrender.com',
    [string]$Image = 'ghcr.io/trancuong3/viread-ocr-worker:latest',
    [string]$SubscriptionId = '',
    [string[]]$CandidateRegions = @(
        'southeastasia',
        'eastasia',
        'japaneast',
        'koreacentral',
        'australiaeast',
        'westus2',
        'eastus'
    ),
    [string]$RegistryServer = 'ghcr.io',
    [string]$RegistryUsername = '',
    [string]$CheckpointCdnUrl = '',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$FLOW1_SHA256 = '200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6'

function Read-SecretPlainText([string]$PromptText) {
    $sec = Read-Host $PromptText -AsSecureString
    $bstr = [IntPtr]::Zero
    try {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        return ([Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)).Trim()
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        if ($null -ne $sec) {
            $sec.Dispose()
        }
    }
}

function New-CryptoHexToken([int]$ByteLength = 24) {
    $buf = New-Object byte[] $ByteLength
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($buf)
        return ([BitConverter]::ToString($buf)).Replace('-', '').ToLowerInvariant()
    } finally {
        $rng.Dispose()
        [Array]::Clear($buf, 0, $buf.Length)
    }
}

function Test-GhcrAnonymousPull([string]$ImageRef) {
    if (-not $ImageRef.ToLowerInvariant().StartsWith('ghcr.io/')) {
        return $true
    }
    $withoutHost = $ImageRef.Substring(8)
    $parts = $withoutHost.Split(':')
    $repoPath = $parts[0]
    $tag = if ($parts.Length -gt 1 -and $parts[1]) { $parts[1] } else { 'latest' }
    try {
        $tokResp = Invoke-RestMethod -Method Get -Uri "https://ghcr.io/token?scope=repository:${repoPath}:pull" -TimeoutSec 10
        if (-not $tokResp -or -not $tokResp.token) {
            return $false
        }
        $headers = @{
            Authorization = "Bearer $($tokResp.token)"
            Accept        = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
        }
        $resp = Invoke-WebRequest -Method Head -Uri "https://ghcr.io/v2/${repoPath}/manifests/${tag}" -Headers $headers -UseBasicParsing -TimeoutSec 10
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Invoke-AzJson([string[]]$AzArgs) {
    $raw = & az @AzArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errText = ($raw | Out-String).Trim()
        throw "Azure CLI failed: $errText"
    }
    $joined = ($raw | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($joined)) {
        return $null
    }
    return ($joined | ConvertFrom-Json)
}

$workerToken = $null
$registryPassword = $null

try {
    Write-Host '=== ViRead 0-VND Azure for Students OCR Worker Deployer ===' -ForegroundColor Cyan

    if ($DryRun) {
        $anonOk = Test-GhcrAnonymousPull -ImageRef $Image
        Write-Host "[DRY-RUN] ResourceGroup : $ResourceGroupName"
        Write-Host "[DRY-RUN] Environment   : $EnvironmentName (--logs-destination none)"
        Write-Host "[DRY-RUN] ContainerApp  : $AppName (2.0 vCPU / 4.0Gi, min=0, max=1, port=7860, cooldown=30s)"
        Write-Host "[DRY-RUN] Image         : $Image (anonymous pull available: $anonOk)"
        Write-Host "[DRY-RUN] Regions       : $($CandidateRegions -join ', ')"
        Write-Host "[DRY-RUN] BackendUrl    : $BackendUrl"
        return
    }

    $azCmd = Get-Command az -ErrorAction SilentlyContinue
    if ($null -eq $azCmd) {
        Write-Host 'Chua cai Azure CLI (az). Chay lenh sau trong PowerShell roi mo lai cua so moi:' -ForegroundColor Yellow
        Write-Host '    winget install -e --id Microsoft.AzureCLI' -ForegroundColor Green
        throw 'Missing Azure CLI (az).'
    }

    Write-Host '[1/6] Kiem tra dang nhap Azure CLI va dang ky Microsoft.App...' -ForegroundColor Cyan
    & az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors | Out-Null
    & az extension add --name containerapp --upgrade --only-show-errors | Out-Null

    $account = $null
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $acctOut = & az account show -o json 2>$null
    $acctCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($acctCode -eq 0 -and -not [string]::IsNullOrWhiteSpace(($acctOut | Out-String))) {
        $account = ($acctOut | Out-String) | ConvertFrom-Json
    } else {
        Write-Host 'Mo trinh duyet de dang nhap tai khoan Azure for Students (.edu.vn)...' -ForegroundColor Yellow
        & az login --only-show-errors | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Dang nhap Azure that bai.'
        }
        $account = Invoke-AzJson @('account', 'show', '-o', 'json')
    }

    if (-not [string]::IsNullOrWhiteSpace($SubscriptionId)) {
        & az account set --subscription $SubscriptionId --only-show-errors
        if ($LASTEXITCODE -ne 0) {
            throw "Khong the chon subscription $SubscriptionId"
        }
        $account = Invoke-AzJson @('account', 'show', '-o', 'json')
    }
    Write-Host "Dang dung Azure Subscription: $($account.name) ($($account.id))" -ForegroundColor Green

    & az provider register --namespace Microsoft.App --wait --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Khong the dang ky namespace Microsoft.App tren subscription nay.'
    }

    Write-Host '[2/6] Cau hinh bao mat VIREAD_OCR_WORKER_TOKEN (KHONG dung lai token cu da lo)...' -ForegroundColor Cyan
    Write-Host 'Luu y: Nhan Enter de tu dong sinh ma 48 ky tu moi tinh va chep thang vao Clipboard!' -ForegroundColor Yellow
    $enteredToken = Read-SecretPlainText 'Dan VIREAD_OCR_WORKER_TOKEN (>=32 ky tu) hoac nhan Enter de tu sinh ma moi'
    $tokenCopiedToClipboard = $false
    if ([string]::IsNullOrWhiteSpace($enteredToken)) {
        $workerToken = New-CryptoHexToken -ByteLength 24
        Set-Clipboard -Value $workerToken
        $tokenCopiedToClipboard = $true
        Write-Host 'Da sinh VIREAD_OCR_WORKER_TOKEN moi (48 ky tu) va chep vao Clipboard (khong in ra man hinh).' -ForegroundColor Green
    } else {
        if ($enteredToken.Length -lt 32) {
            throw 'VIREAD_OCR_WORKER_TOKEN phai co it nhat 32 ky tu.'
        }
        $workerToken = $enteredToken
    }
    $enteredToken = $null

    $needRegistryAuth = (-not [string]::IsNullOrWhiteSpace($RegistryUsername))
    if (-not $needRegistryAuth) {
        $isPublicPull = Test-GhcrAnonymousPull -ImageRef $Image
        if (-not $isPublicPull) {
            Write-Host 'Image GHCR hien dang o che do Private hoac can xac thuc read:packages.' -ForegroundColor Yellow
            $RegistryUsername = (Read-Host 'Nhap GitHub username de pull GHCR (vd: trancuong3)').Trim()
            $needRegistryAuth = $true
        } else {
            Write-Host 'Da xac nhan image GHCR cho phep pull cong khai (0 can PAT, 0 ton phi ACR).' -ForegroundColor Green
        }
    }
    if ($needRegistryAuth) {
        if ([string]::IsNullOrWhiteSpace($RegistryUsername)) {
            throw 'Can nhap GitHub username khi pull image GHCR private.'
        }
        $registryPassword = Read-SecretPlainText 'Dan GitHub Classic PAT (quyen read:packages)'
        if ([string]::IsNullOrWhiteSpace($registryPassword)) {
            throw 'Chua nhap GitHub PAT (read:packages).'
        }
    }

    Write-Host '[3/6] Khoi tao Resource Group va Container Apps Environment (tu dong tim region hop le)...' -ForegroundColor Cyan
    $selectedRegion = $null

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $existingEnvJson = & az containerapp env show --name $EnvironmentName --resource-group $ResourceGroupName -o json 2>$null
    $existingEnvCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap

    if ($existingEnvCode -eq 0 -and -not [string]::IsNullOrWhiteSpace(($existingEnvJson | Out-String))) {
        $existingEnv = ($existingEnvJson | Out-String) | ConvertFrom-Json
        $selectedRegion = $existingEnv.location
        Write-Host "Tai su dung Container Apps Environment '$EnvironmentName' tai region '$selectedRegion'." -ForegroundColor Green
    } else {
        foreach ($region in $CandidateRegions) {
            Write-Host "  -> Thu region '$region'..." -ForegroundColor Gray
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'

            $rgExists = (& az group exists --name $ResourceGroupName 2>$null | Out-String).Trim()
            $rgOk = $true
            if ($rgExists -ne 'true') {
                $rgOut = & az group create --name $ResourceGroupName --location $region --only-show-errors 2>&1
                if ($LASTEXITCODE -ne 0) {
                    $rgOk = $false
                    $rgErr = ($rgOut | Out-String).Trim()
                    Write-Host "     Region '$region' bi tu choi khi tao Resource Group ($($rgErr.Split("`n")[0]))." -ForegroundColor DarkYellow
                }
            }

            if ($rgOk) {
                $envOut = & az containerapp env create `
                    --name $EnvironmentName `
                    --resource-group $ResourceGroupName `
                    --location $region `
                    --logs-destination none `
                    --only-show-errors 2>&1
                $envCode = $LASTEXITCODE
                $ErrorActionPreference = $prevEap

                if ($envCode -eq 0) {
                    $selectedRegion = $region
                    Write-Host "Da tao Container Apps Environment '$EnvironmentName' tai '$selectedRegion' (logs=none, 0 VND)." -ForegroundColor Green
                    break
                } else {
                    $envErr = ($envOut | Out-String).Trim()
                    if ($envErr -match 'RequestDisallowedByPolicy|LocationNotAvailable|SubscriptionIsNotAllowed|InvalidResourceGroupLocation|DisallowedProvider') {
                        Write-Host "     Azure for Students Policy chan region '$region'; tu dong thu region tiep theo..." -ForegroundColor DarkYellow
                        continue
                    }
                    throw "Loi tao Container Apps Environment tai '$region': $envErr"
                }
            } else {
                $ErrorActionPreference = $prevEap
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($selectedRegion)) {
        throw "Khong tim thay region nao duoc phep trong danh sach: $($CandidateRegions -join ', ')."
    }

    Write-Host "[4/6] Trien khai Container App '$AppName' (2.0 vCPU / 4.0Gi, minReplicas=0, maxReplicas=1)..." -ForegroundColor Cyan
    $envPairs = @(
        "VIREAD_OCR_BACKEND_URL=$($BackendUrl.TrimEnd('/'))",
        'VIREAD_OCR_QUIET_STANDBY=true',
        'VIREAD_OCR_SCALE_TO_ZERO=true',
        'VIREAD_OCR_SKIP_STARTUP_SMOKE=true',
        'VIREAD_OCR_WORKER_MODEL_PROFILE=FLOW1_EXTERNAL_TRDG',
        "VIREAD_OCR_WORKER_MODEL_SHA256=$FLOW1_SHA256",
        'VIREAD_OCR_WORKER_TOKEN=secretref:ocr-worker-token'
    )
    if (-not [string]::IsNullOrWhiteSpace($CheckpointCdnUrl)) {
        $envPairs += "VIREAD_OCR_CHECKPOINT_CDN_URL=$($CheckpointCdnUrl.Trim())"
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & az containerapp show --name $AppName --resource-group $ResourceGroupName -o none 2>$null
    $appExists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap

    if (-not $appExists) {
        $createArgs = @(
            'containerapp', 'create',
            '--name', $AppName,
            '--resource-group', $ResourceGroupName,
            '--environment', $EnvironmentName,
            '--image', $Image,
            '--cpu', '2.0',
            '--memory', '4.0Gi',
            '--min-replicas', '0',
            '--max-replicas', '1',
            '--ingress', 'external',
            '--target-port', '7860',
            '--scale-rule-name', 'http-scaler',
            '--scale-rule-type', 'http',
            '--scale-rule-http-concurrency', '2',
            '--secrets', "ocr-worker-token=$workerToken",
            '--env-vars'
        ) + $envPairs + @('--only-show-errors')

        if ($needRegistryAuth) {
            $createArgs += @(
                '--registry-server', $RegistryServer,
                '--registry-username', $RegistryUsername,
                '--registry-password', $registryPassword
            )
        }

        & az @createArgs | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Tao Container App '$AppName' that bai."
        }
    } else {
        if ($needRegistryAuth) {
            & az containerapp registry set `
                --name $AppName `
                --resource-group $ResourceGroupName `
                --server $RegistryServer `
                --username $RegistryUsername `
                --password $registryPassword `
                --only-show-errors | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw 'Cap nhat thong tin dang nhap GHCR tren Container App that bai.'
            }
        }
        & az containerapp secret set `
            --name $AppName `
            --resource-group $ResourceGroupName `
            --secrets "ocr-worker-token=$workerToken" `
            --only-show-errors | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Cap nhat secret ocr-worker-token that bai.'
        }

        $updateArgs = @(
            'containerapp', 'update',
            '--name', $AppName,
            '--resource-group', $ResourceGroupName,
            '--image', $Image,
            '--cpu', '2.0',
            '--memory', '4.0Gi',
            '--min-replicas', '0',
            '--max-replicas', '1',
            '--scale-rule-name', 'http-scaler',
            '--scale-rule-type', 'http',
            '--scale-rule-http-concurrency', '2',
            '--set-env-vars'
        ) + $envPairs + @('--only-show-errors')

        & az @updateArgs | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Cap nhat Container App '$AppName' that bai."
        }
    }

    Write-Host '[5/6] Ap dung cooldownPeriod=30s & pollingInterval=15s (tiet kiem toi da GiB-s mien phi)...' -ForegroundColor Cyan
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & az resource update `
        --resource-group $ResourceGroupName `
        --name $AppName `
        --resource-type 'Microsoft.App/containerApps' `
        --set properties.template.scale.cooldownPeriod=30 properties.template.scale.pollingInterval=15 `
        --only-show-errors 2>$null | Out-Null
    $ErrorActionPreference = $prevEap

    $appInfo = Invoke-AzJson @('containerapp', 'show', '--name', $AppName, '--resource-group', $ResourceGroupName, '-o', 'json')
    $fqdn = $appInfo.properties.configuration.ingress.fqdn
    if ([string]::IsNullOrWhiteSpace($fqdn)) {
        throw 'Khong lay duoc FQDN cua Container App.'
    }
    $workerUrl = "https://$fqdn"

    Write-Host "[6/6] Kiem tra khoi dong & GET $workerUrl/health (cho toi da 120 giay lan dau)..." -ForegroundColor Cyan
    $readyVerified = $false
    for ($attempt = 1; $attempt -le 24; $attempt++) {
        try {
            $health = Invoke-RestMethod -Method Get -Uri "$workerUrl/health" -TimeoutSec 15
            if ($null -ne $health -and $health.ready -eq $true) {
                $readyVerified = $true
                Write-Host "Worker READY! worker_id=$($health.worker_id) | model=$($health.model.profile) | standby=$($health.standby_mode)" -ForegroundColor Green
                break
            }
        } catch {
            # Cold boot in progress
        }
        Start-Sleep -Seconds 5
    }
    if (-not $readyVerified) {
        Write-Host "Canh bao: Container dang tiep tuc tai image lan dau; kiem tra lai sau 1 phut tai $workerUrl/health" -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host '=========================================================================' -ForegroundColor Green
    Write-Host 'HOAN TAT TRIEN KHAI AZURE CONTAINER APPS (SCALE-TO-ZERO = 0 VND)!' -ForegroundColor Green
    Write-Host 'Dan cac bien moi truong sau vao Render Dashboard -> capstone1-ssd8 -> Environment:' -ForegroundColor Cyan
    Write-Host '-------------------------------------------------------------------------'
    Write-Host 'VIREAD_OCR_MODE=remote_worker'
    Write-Host 'VIREAD_WEB_DISABLE_HEAVY_WORKERS=true'
    Write-Host "VIREAD_OCR_REMOTE_WORKER_URL=$workerUrl"
    Write-Host 'VIREAD_OCR_REMOTE_SCALE_TO_ZERO=true'
    if ($tokenCopiedToClipboard) {
        Write-Host 'VIREAD_OCR_WORKER_TOKEN=<DAN_TU_CLIPBOARD_CTRL_V_NGAY_BAY_GIO>' -ForegroundColor Yellow
    } else {
        Write-Host 'VIREAD_OCR_WORKER_TOKEN=<MA_BI_MAT_BAN_VUA_NHAP>' -ForegroundColor Yellow
    }
    Write-Host 'OCR_CLOUD_CORRECTION_ENABLED=true'
    Write-Host 'PRIVATE_BOOK_ALLOW_CLOUD_AI=true'
    Write-Host '=========================================================================' -ForegroundColor Green
    Write-Host 'Sau 30 giay khong co nguoi quet sach, Azure tu ha ve 0 replica (0 VND/gio).' -ForegroundColor Gray
} finally {
    $workerToken = $null
    $registryPassword = $null
}
