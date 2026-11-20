# Windows launcher for the standalone autonomous incident demo (no SpacetimeDB needed).
#   cd hardware ; .\start_demo.ps1
# Loads hardware\.env if present (values are never printed), creates .venv on first run,
# installs requirements, then serves the bridge on 0.0.0.0:8765 so the Arduino can reach it.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# --- .env (KEY=value lines; comments and blanks skipped) ---
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $l = $line.Trim()
        if ($l -eq "" -or $l.StartsWith("#") -or -not $l.Contains("=")) { continue }
        $i = $l.IndexOf("=")
        $k = $l.Substring(0, $i).Trim()
        $v = $l.Substring($i + 1).Trim()
        if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        if (($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) -or ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2)) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        Set-Item -Path ("Env:" + $k) -Value $v
    }
    Write-Host "Loaded .env (values not shown)."
} else {
    Write-Host "No .env found - using defaults / existing environment."
}

foreach ($name in @("SENTINEL_DEVICE_TOKEN")) {
    $val = [Environment]::GetEnvironmentVariable($name)
    if (-not $val -or $val.Length -lt 16) {
        Write-Warning "$name is missing or shorter than 16 chars: the bridge will answer 503 to the Arduino. Copy .env.example to .env and fill it in."
    }
}
if ($env:NVIDIA_API_KEY) { Write-Host "Agent mode: Nemotron will word findings/summaries (falls back to scripted text on any error)." }
else { Write-Host "Agent mode: scripted (set NVIDIA_API_KEY in .env to use Nemotron)." }

# --- venv ---
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Creating .venv (first run only)..."
    $sys = Get-Command python -ErrorAction SilentlyContinue
    if (-not $sys) { $sys = Get-Command py -ErrorAction SilentlyContinue }
    if (-not $sys) { throw "Python 3.9+ not found on PATH." }
    & $sys.Source -m venv .venv
}
& $py -c "import fastapi, uvicorn, httpx" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing requirements..."
    & $py -m pip install -q -r requirements.txt
}

# --- network info ---
$ips = @()
try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        ForEach-Object { $_.IPAddress }
} catch { }
Write-Host ""
if ($ips.Count -gt 0) {
    Write-Host "Laptop IPv4 (put this in the Arduino BRIDGE_HOST): $($ips -join ', ')"
} else {
    Write-Host "Could not detect the laptop IPv4 - run ipconfig."
}
Write-Host "Bridge listening on port 8765 (allow it in Windows Firewall for private networks if the Arduino cannot connect)."
Write-Host "Demo state API:  http://localhost:8765/demo/state"
Write-Host "Demo URL:        http://localhost:8765/demo   (points to the React dashboard at http://localhost:5173/demo)"
Write-Host ""

& $py -m uvicorn bridge:app --host 0.0.0.0 --port 8765
