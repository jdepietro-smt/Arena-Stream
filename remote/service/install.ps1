# Run from an elevated PowerShell. Publishes the helper to Program Files and registers the Windows service.
#   .\install.ps1 -ClientExe "C:\Program Files\Arena Remote\Arena Remote.exe"
param([Parameter(Mandatory)][string]$ClientExe, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:ProgramFiles 'Arena Remote\service'
$svc = Join-Path $dest 'ArenaRemoteService.exe'
if ($Uninstall) { & $svc uninstall; Remove-Item -Recurse -Force $dest; return }
dotnet publish "$PSScriptRoot\ArenaRemoteService.csproj" -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o $dest
& $svc install --client $ClientExe
