param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$backendDir = Join-Path $projectRoot 'backend'
$frontendDir = Join-Path $projectRoot 'frontend'
$envFile = Join-Path $backendDir '.env'
$logDir = Join-Path $projectRoot '.run-logs'
$processes = @()

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Start-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Arguments
    )

    $stdout = Join-Path $logDir "$Name.out.log"
    $stderr = Join-Path $logDir "$Name.err.log"
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath 'npm.cmd' -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
    $script:processes += [pscustomobject]@{ Name = $Name; Process = $proc; Out = $stdout; Err = $stderr; OutPosition = 0; ErrPosition = 0 }
    Write-Host "Started $Name (PID $($proc.Id)); logs are shown below."
}

function Write-NewLogLines {
    foreach ($entry in $script:processes) {
        foreach ($stream in @(
            [pscustomobject]@{ Path = $entry.Out; Position = 'OutPosition'; Label = $entry.Name },
            [pscustomobject]@{ Path = $entry.Err; Position = 'ErrPosition'; Label = "$($entry.Name) error" }
        )) {
            if (Test-Path -LiteralPath $stream.Path) {
                $file = [System.IO.File]::Open($stream.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                try {
                    [void]$file.Seek($entry.($stream.Position), [System.IO.SeekOrigin]::Begin)
                    $reader = [System.IO.StreamReader]::new($file)
                    $text = $reader.ReadToEnd()
                    $entry.($stream.Position) = $file.Position
                    foreach ($line in ($text -split "`r?`n")) {
                        if ($line) { Write-Host "[$($stream.Label)] $line" }
                    }
                } finally {
                    $file.Dispose()
                }
            }
        }
    }
}

try {
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "Missing $envFile. Copy backend/.env.example to backend/.env and fill in the settings first."
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not installed or is not on PATH.' }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js/npm is not installed or is not on PATH.' }
    if (-not (Test-Path (Join-Path $backendDir 'node_modules')) -or -not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
        throw 'Project dependencies are missing. Run npm install once in backend and frontend, then run this script again.'
    }

    Write-Host 'Starting PostgreSQL, Redis, and Elasticsearch...'
    Invoke-CheckedCommand -FilePath 'docker' -ArgumentList @('compose', 'up', '-d', '--wait') -WorkingDirectory $backendDir

    Write-Host 'Preparing the database...'
    Invoke-CheckedCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'db:deploy') -WorkingDirectory $backendDir

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Start-LoggedProcess -Name 'api' -WorkingDirectory $backendDir -Arguments 'run dev'
    Start-LoggedProcess -Name 'worker' -WorkingDirectory $backendDir -Arguments 'run dev:worker'
    Start-LoggedProcess -Name 'frontend' -WorkingDirectory $frontendDir -Arguments 'run dev'

    Write-Host ''
    Write-Host 'ReachInbox is running at http://localhost:5173'
    Write-Host 'Press Ctrl+C here to stop the API, worker, and frontend. Docker services stay running.'
    if (-not $NoBrowser) { Start-Process 'http://localhost:5173' }

    while ($true) {
        Write-NewLogLines
        $stopped = $processes | Where-Object { $_.Process.HasExited }
        if ($stopped) {
            $names = ($stopped | ForEach-Object { $_.Name }) -join ', '
            throw "A ReachInbox process stopped unexpectedly: $names. See .run-logs for details."
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    foreach ($entry in $processes) {
        if (-not $entry.Process.HasExited) {
            & taskkill.exe /PID $entry.Process.Id /T /F 2>$null | Out-Null
        }
    }
    if ($processes.Count -gt 0) { Write-Host 'ReachInbox app processes stopped.' }
}
