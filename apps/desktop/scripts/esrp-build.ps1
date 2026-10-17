# Copyright (c) Microsoft Corporation.
# Licensed under the MIT license.

param(
    [Parameter(Mandatory)]
    [ValidateSet('Start', 'Build', 'Wait', 'Resume', 'Finish', 'Stop')]
    [string] $Action,
    [ValidateSet('app', 'elevate', 'uninstaller', 'installer')]
    [string] $Stage
)

$ErrorActionPreference = 'Stop'
$root = $env:HUABU_ESRP_STATE
if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root)) {
    throw 'HUABU_ESRP_STATE must be an absolute CI signing directory'
}

function Show-BuildLog {
    foreach ($name in @('stdout.log', 'stderr.log')) {
        $log = Join-Path $root $name
        if (Test-Path -LiteralPath $log) {
            Get-Content -LiteralPath $log -Tail 100
        }
    }
}

function Assert-BuildRunning {
    $exitFile = Join-Path $root 'exit-code'
    if (Test-Path -LiteralPath $exitFile) {
        Show-BuildLog
        throw "Build exited before the expected signing handoff: $(Get-Content -LiteralPath $exitFile)"
    }
    $processId = [int](Get-Content -LiteralPath (Join-Path $root 'pid'))
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        Show-BuildLog
        throw 'The ESRP packaging process is no longer running'
    }
}

function Get-VerifiedSignature([string] $file) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
        throw "Missing valid timestamped Authenticode signature: $file ($($signature.Status))"
    }
    return $signature
}

switch ($Action) {
    'Start' {
        if (Test-Path -LiteralPath $root) {
            throw "Signing state already exists: $root"
        }
        New-Item -ItemType Directory -Path $root | Out-Null
        $output = [IO.Path]::GetFullPath((Join-Path $env:BUILD_SOURCESDIRECTORY '..\huabu-electron-out'))
        $package = Get-Content -LiteralPath (Join-Path $env:BUILD_SOURCESDIRECTORY 'apps\desktop\package.json') -Raw | ConvertFrom-Json
        @{ output = $output; version = $package.version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'build.json') -Encoding utf8
        # Keep packaging alive across sequential Azure tasks while its sign hook waits.
        $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') `
            -ArgumentList @('-NoProfile', '-File', "`"$PSCommandPath`"", '-Action', 'Build') `
            -WorkingDirectory $env:BUILD_SOURCESDIRECTORY `
            -RedirectStandardOutput (Join-Path $root 'stdout.log') `
            -RedirectStandardError (Join-Path $root 'stderr.log') -PassThru
        $process.Id | Set-Content -LiteralPath (Join-Path $root 'pid')
        Assert-BuildRunning
    }
    'Build' {
        $exitCode = 1
        try {
            Set-Location $env:BUILD_SOURCESDIRECTORY
            # Disable executable signing caches so every CI run reaches every handoff.
            $env:ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true'
            pnpm run build:desktop:win --config electron-builder.esrp.yml
            $exitCode = $LASTEXITCODE
        }
        finally {
            $exitCode | Set-Content -LiteralPath (Join-Path $root 'exit-code.tmp')
            Move-Item -LiteralPath (Join-Path $root 'exit-code.tmp') -Destination (Join-Path $root 'exit-code')
        }
        exit $exitCode
    }
    'Wait' {
        if (-not $Stage) { throw 'Wait requires a signing stage' }
        $directory = Join-Path $root $Stage
        $deadline = [DateTime]::UtcNow.AddMinutes(30)
        while (-not (Test-Path -LiteralPath (Join-Path $directory 'ready'))) {
            Assert-BuildRunning
            if ([DateTime]::UtcNow -ge $deadline) {
                Show-BuildLog
                throw "Timed out waiting for the $Stage signing input"
            }
            Start-Sleep -Seconds 1
        }
        Assert-BuildRunning
        $hash = (Get-FileHash -LiteralPath (Join-Path $directory 'artifact.exe') -Algorithm SHA256).Hash
        if ($hash -ne (Get-Content -LiteralPath (Join-Path $directory 'ready') -Raw).Trim()) {
            throw "Signing input changed before ESRP: $Stage"
        }
        Write-Host "Ready for ESRP signing: $Stage"
    }
    'Resume' {
        if (-not $Stage) { throw 'Resume requires a signing stage' }
        Assert-BuildRunning
        $directory = Join-Path $root $Stage
        $file = Join-Path $directory 'artifact.exe'
        $signature = Get-VerifiedSignature $file
        $publisher = $signature.SignerCertificate.Subject
        if ($Stage -ne 'app') {
            $appReceipt = Get-Content -LiteralPath (Join-Path $root 'app\signed.json') -Raw | ConvertFrom-Json
            if ($publisher -ne $appReceipt.publisher) {
                throw "Signer does not match the application publisher: $Stage"
            }
        }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($hash -eq (Get-Content -LiteralPath (Join-Path $directory 'ready') -Raw).Trim()) {
            throw "ESRP did not modify the signing input: $Stage"
        }
        @{ publisher = $publisher; sha256 = $hash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'signed.tmp') -Encoding utf8
        Move-Item -LiteralPath (Join-Path $directory 'signed.tmp') -Destination (Join-Path $directory 'signed.json')
    }
    'Finish' {
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
        $exitFile = Join-Path $root 'exit-code'
        $processId = [int](Get-Content -LiteralPath (Join-Path $root 'pid'))
        while (-not (Test-Path -LiteralPath $exitFile)) {
            # Completion can arrive between the loop condition and the process lookup.
            if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $exitFile)) {
                Show-BuildLog
                throw 'The ESRP packaging process is no longer running and did not record an exit code'
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                Show-BuildLog
                throw 'Timed out finishing the signed installer'
            }
            Start-Sleep -Seconds 1
        }
        Show-BuildLog
        $exitCode = [int](Get-Content -LiteralPath $exitFile)
        if ($exitCode -ne 0) { throw "Desktop packaging failed with exit code $exitCode" }
        foreach ($name in @('app', 'elevate', 'uninstaller', 'installer')) {
            $null = Get-VerifiedSignature (Join-Path $root "$name\artifact.exe")
        }
        node (Join-Path $PSScriptRoot 'esrp-validate.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Signed release metadata validation failed' }
    }
    'Stop' {
        if (Test-Path -LiteralPath $root) {
            New-Item -ItemType File -Path (Join-Path $root 'abort') -Force | Out-Null
            $pidFile = Join-Path $root 'pid'
            if (Test-Path -LiteralPath $pidFile) {
                $processId = [int](Get-Content -LiteralPath $pidFile)
                if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
                    & taskkill.exe /PID $processId /T /F
                    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                        throw "Could not stop packaging process $processId"
                    }
                    $global:LASTEXITCODE = 0
                }
            }
            Show-BuildLog
        }
    }
}
