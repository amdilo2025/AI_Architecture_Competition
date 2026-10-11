$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot '.tmp') | Out-Null
$env:TMP = Join-Path $PSScriptRoot '.tmp'
$env:TEMP = $env:TMP
$pythonCandidate = $env:DISPATCH_PYTHON
if (-not $pythonCandidate) {
    $candidateList = @('python', (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'))
    foreach ($candidate in $candidateList) {
        try {
            $versionCheck = & $candidate -c 'import sys; print(sys.executable); assert sys.version_info >= (3, 11)' 2>$null
            if ($LASTEXITCODE -eq 0) { $pythonCandidate = [string]($versionCheck | Select-Object -First 1); break }
        } catch { }
    }
}
if (-not $pythonCandidate) { throw 'Install Python 3.11+ or set DISPATCH_PYTHON to the Python executable.' }
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $pythonCandidate -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python virtual environment.' }
}
$projectPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $projectPython -m pip install -r requirements.lock.txt --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
& $projectPython scripts/generate_tokens.py
if ($LASTEXITCODE -ne 0) { throw 'Design token generation failed.' }
Push-Location -LiteralPath frontend
try {
    & npm.cmd ci --cache (Join-Path $PSScriptRoot '.tmp\npm-cache') --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Write-Output 'Setup complete. Run .\start.ps1, then open http://127.0.0.1:8080'
