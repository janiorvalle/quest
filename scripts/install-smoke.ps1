# The PowerShell half of install-smoke.ts. Runs install.ps1 the way the README
# line does, `irm ... | iex`, and fails on anything the session gained from it.
# On Windows it also installs into a relative folder and checks the user PATH
# got the absolute one, then puts the PATH back.
param([Parameter(Mandatory = $true)][string]$Work)
$ErrorActionPreference = "Stop"

$installer = Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1"

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "install smoke: $Message"
  }
}

$env:QUEST_INSTALL_DIR = Join-Path $Work "session-bin"
$env:QUEST_INSTALL_SKIP_PATH = "1"
$before = @(Get-Variable | ForEach-Object Name) + @(Get-Command -CommandType Function | ForEach-Object Name)
Get-Content -Raw $installer | Invoke-Expression
$after = @(Get-Variable | ForEach-Object Name) + @(Get-Command -CommandType Function | ForEach-Object Name)
$leaked = @($after | Where-Object { $_ -notin $before -and $_ -ne "before" })
Assert ($leaked.Count -eq 0) "install.ps1 left these in the session: $($leaked -join ', ')"
Write-Output "install.ps1 through iex left nothing in the session"

if (-not $IsWindows) {
  exit 0
}

# The registry write that puts the PATH back says nothing to Explorer. A
# user-variable write through .NET sends the same environment-change broadcast
# the installer does, so a terminal opened afterwards sees the restored PATH
# and not the folder this smoke deleted. The variable itself goes right away.
function Publish-EnvironmentChange {
  [Environment]::SetEnvironmentVariable("QUEST_INSTALL_SMOKE", "1", "User")
  [Environment]::SetEnvironmentVariable("QUEST_INSTALL_SMOKE", $null, "User")
}

$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
$savedKind = $environmentKey.GetValueKind("Path")
$savedPath = [string]$environmentKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
Push-Location $Work
try {
  $env:QUEST_INSTALL_DIR = "relative-bin"
  Remove-Item Env:QUEST_INSTALL_SKIP_PATH
  & pwsh -NoProfile -File $installer | Out-Host
  Assert ($LASTEXITCODE -eq 0) "install into a relative folder failed"
  $absolute = Join-Path (Get-Location).Path "relative-bin"
  Assert (Test-Path (Join-Path $absolute "quest.exe")) "quest.exe did not land in $absolute"
  $userPath = @([string]$environmentKey.GetValue("Path", "") -split ";")
  Assert ($absolute -in $userPath) "the user PATH did not get $absolute"
  Assert ("relative-bin" -notin $userPath) "the user PATH got the relative folder as written"
  Write-Output "a relative QUEST_INSTALL_DIR went on the user PATH as $absolute"
} finally {
  Pop-Location
  $environmentKey.SetValue("Path", $savedPath, $savedKind)
  Publish-EnvironmentChange
  $environmentKey.Dispose()
}
