param(
    [string]$Python = "D:\python\python.exe"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$AppRoot = Join-Path $ProjectRoot "app"
$ReleaseDir = Join-Path $AppRoot "TuinaPatientManager"
$BuildDir = Join-Path $ProjectRoot "build\tuina_app"
$ZipPath = Join-Path $AppRoot "tuina_windows_with_data_2026-07-11.zip"

if ($ProjectRoot -ne "L:\for_mom\tuina") {
    throw "Unexpected project root: $ProjectRoot"
}

foreach ($path in @($ReleaseDir, $BuildDir, $ZipPath)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null

& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --workpath $BuildDir `
    --distpath $AppRoot `
    (Join-Path $ProjectRoot "tuina_app.spec")
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

Copy-Item -LiteralPath (Join-Path $ProjectRoot "data") -Destination $ReleaseDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "doc_patient") -Destination $ReleaseDir -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $ReleaseDir "doc_patient") -Directory -Filter "__pycache__" -Recurse | ForEach-Object {
    $cachePath = [System.IO.Path]::GetFullPath($_.FullName)
    if (-not $cachePath.StartsWith([System.IO.Path]::GetFullPath($ReleaseDir), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected cache path: $cachePath"
    }
    Remove-Item -LiteralPath $cachePath -Recurse -Force
}
foreach ($name in @("tecent_api_key.txt", "tencent_api_key.txt", "jianguoyun_key.txt")) {
    $source = Join-Path $ProjectRoot $name
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $ReleaseDir $name) -Force
    }
}

Copy-Item -LiteralPath (Join-Path $ProjectRoot "packaging\windows\启动推拿系统.bat") -Destination (Join-Path $AppRoot "启动推拿系统.bat") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "packaging\windows\使用说明.txt") -Destination (Join-Path $AppRoot "使用说明.txt") -Force

& $Python (Join-Path $ProjectRoot "tools\create_release_zip.py")
if ($LASTEXITCODE -ne 0) {
    throw "Archive creation failed with exit code $LASTEXITCODE"
}

Write-Host "Release directory: $ReleaseDir"
Write-Host "Zip package: $ZipPath"


