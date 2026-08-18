$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  throw "quest installer: $Message"
}

function Publish-EnvironmentChange {
  if (-not ([System.Management.Automation.PSTypeName]"Quest.EnvironmentChange").Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace Quest {
  public static class EnvironmentChange {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr window,
      uint message,
      UIntPtr messageParameter,
      string environmentName,
      uint flags,
      uint timeout,
      out UIntPtr result
    );
  }
}
"@
  }

  $result = [UIntPtr]::Zero
  [void][Quest.EnvironmentChange]::SendMessageTimeout(
    [IntPtr]0xffff,
    [uint32]0x001A,
    [UIntPtr]::Zero,
    "Environment",
    [uint32]0x0002,
    [uint32]5000,
    [ref]$result
  )
}

$repo = if ($env:QUEST_INSTALL_REPO) { $env:QUEST_INSTALL_REPO } else { "janiorvalle/quest" }
$apiBaseUrl = if ($env:QUEST_INSTALL_API_BASE_URL) {
  $env:QUEST_INSTALL_API_BASE_URL.TrimEnd("/")
} else {
  "https://api.github.com"
}
$installDir = if ($env:QUEST_INSTALL_DIR) {
  $env:QUEST_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Programs\quest"
}
$version = $env:QUEST_INSTALL_VERSION
$releaseTag = $env:QUEST_INSTALL_TAG
$githubToken = if ($env:QUEST_GITHUB_TOKEN) {
  $env:QUEST_GITHUB_TOKEN
} elseif ($env:GH_TOKEN) {
  $env:GH_TOKEN
} else {
  $env:GITHUB_TOKEN
}
$apiHeaders = @{
  Accept = "application/vnd.github+json"
  "User-Agent" = "quest-installer"
}
if ($githubToken) {
  $apiHeaders.Authorization = "Bearer $githubToken"
}

function Get-GitHubRelease([string]$Uri) {
  try {
    Invoke-RestMethod $Uri -Headers $apiHeaders -ErrorAction Stop
  } catch {
    Fail "could not read release metadata; check the token and release tag"
  }
}

function Download-ReleaseAsset([object]$Asset, [string]$FallbackUrl, [string]$Destination) {
  try {
    if ($githubToken) {
      $downloadHeaders = @{
        Accept = "application/octet-stream"
        Authorization = "Bearer $githubToken"
        "User-Agent" = "quest-installer"
      }
      Invoke-WebRequest $Asset.url -Headers $downloadHeaders -OutFile $Destination -UseBasicParsing -ErrorAction Stop
    } else {
      Invoke-WebRequest $FallbackUrl -OutFile $Destination -UseBasicParsing -ErrorAction Stop
    }
  } catch {
    Fail "could not download the release asset"
  }
}

$release = $null
if (-not $version) {
  try {
    $release = Get-GitHubRelease "$apiBaseUrl/repos/$repo/releases/latest"
  } catch {
    Fail "no published release found for $repo; set QUEST_GITHUB_TOKEN for a private repository"
  }
  $releaseTag = [string]$release.tag_name
  $version = $releaseTag
}
$version = $version.TrimStart("v")
if (-not $releaseTag) {
  $releaseTag = "v$version"
}
if (
  $githubToken -and
  $null -eq $release -and
  -not $env:QUEST_INSTALL_ARTIFACT -and
  -not $env:QUEST_INSTALL_CHECKSUMS
) {
  $release = Get-GitHubRelease "$apiBaseUrl/repos/$repo/releases/tags/$releaseTag"
}
$artifactName = "quest-$version-windows-x64.exe"

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "quest-install-$PID"
New-Item -ItemType Directory -Force $temporaryDirectory | Out-Null
$artifact = Join-Path $temporaryDirectory $artifactName
$checksums = Join-Path $temporaryDirectory "checksums.txt"

function Invoke-QuestVersion([string]$Executable) {
  $smokeHome = Join-Path $temporaryDirectory "smoke-home"
  $smokeConfig = Join-Path $smokeHome "config"
  $smokeState = Join-Path $smokeHome "state"
  New-Item -ItemType Directory -Force $smokeConfig, $smokeState | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Executable
  $startInfo.Arguments = "--version"
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables["HOME"] = $smokeHome
  $startInfo.EnvironmentVariables["USERPROFILE"] = $smokeHome
  $startInfo.EnvironmentVariables["XDG_CONFIG_HOME"] = $smokeConfig
  $startInfo.EnvironmentVariables["XDG_STATE_HOME"] = $smokeState
  $startInfo.EnvironmentVariables["APPDATA"] = $smokeConfig
  $startInfo.EnvironmentVariables["LOCALAPPDATA"] = $smokeState

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    [void]$process.Start()
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    [PSCustomObject]@{
      ExitCode = $process.ExitCode
      StandardError = $standardError
      StandardOutput = $standardOutput
    }
  } catch {
    Fail "could not start the quest version smoke test: $($_.Exception.Message). Confirm this release matches Windows x64, then retry the installer."
  } finally {
    $process.Dispose()
  }
}

function Assert-QuestVersion([string]$Executable, [string]$Stage) {
  $result = Invoke-QuestVersion $Executable
  $reportedVersion = $result.StandardOutput.Trim()
  if ($result.ExitCode -ne 0) {
    $details = @($result.StandardOutput, $result.StandardError) |
      Where-Object { $_ -and $_.Trim() } |
      ForEach-Object { $_.Trim() }
    $detailText = (($details -join " ") -replace "\s+", " ").Trim()
    if (-not $detailText) {
      $detailText = "the executable produced no output"
    }
    Fail "$Stage quest failed its version smoke test (exit $($result.ExitCode)): $detailText. Confirm Windows security tools allow the release executable, then retry the installer; if it still fails, include this output in the bug report."
  }
  if ($reportedVersion -ne "quest $version") {
    Fail "$Stage quest reported '$reportedVersion' instead of 'quest $version'. Retry the installer; if it still fails, report both versions."
  }
}

try {
  if ($env:QUEST_INSTALL_ARTIFACT -or $env:QUEST_INSTALL_CHECKSUMS) {
    if (-not $env:QUEST_INSTALL_ARTIFACT -or -not $env:QUEST_INSTALL_CHECKSUMS) {
      Fail "QUEST_INSTALL_ARTIFACT and QUEST_INSTALL_CHECKSUMS must be set together"
    }
    Copy-Item $env:QUEST_INSTALL_ARTIFACT $artifact
    Copy-Item $env:QUEST_INSTALL_CHECKSUMS $checksums
  } else {
    $baseUrl = if ($env:QUEST_INSTALL_BASE_URL) {
      $env:QUEST_INSTALL_BASE_URL.TrimEnd("/")
    } else {
      "https://github.com/$repo/releases/download/$releaseTag"
    }
    if ($githubToken) {
      $artifactAsset = @($release.assets | Where-Object { $_.name -eq $artifactName }) | Select-Object -First 1
      $checksumAsset = @($release.assets | Where-Object { $_.name -eq "checksums.txt" }) | Select-Object -First 1
      if ($null -eq $artifactAsset) {
        Fail "release metadata has no asset named $artifactName"
      }
      if ($null -eq $checksumAsset) {
        Fail "release metadata has no asset named checksums.txt"
      }
      Download-ReleaseAsset $artifactAsset "$baseUrl/$artifactName" $artifact
      Download-ReleaseAsset $checksumAsset "$baseUrl/checksums.txt" $checksums
    } else {
      Download-ReleaseAsset $null "$baseUrl/$artifactName" $artifact
      Download-ReleaseAsset $null "$baseUrl/checksums.txt" $checksums
    }
  }

  $escapedArtifactName = [regex]::Escape($artifactName)
  $checksumLine = Get-Content $checksums |
    Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$escapedArtifactName$" } |
    Select-Object -First 1
  if (-not $checksumLine) {
    Fail "checksums.txt has no entry for $artifactName"
  }
  $expected = ($checksumLine -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $artifactName"
  }

  Assert-QuestVersion $artifact "downloaded"

  New-Item -ItemType Directory -Force $installDir | Out-Null
  $destination = Join-Path $installDir "quest.exe"
  $stage = Join-Path $installDir ".quest.new.$PID.exe"
  $previous = Join-Path $temporaryDirectory ".quest.previous.exe"
  $hadPrevious = Test-Path -LiteralPath $destination
  Copy-Item $artifact $stage
  if ($hadPrevious) {
    Copy-Item $destination $previous
  }
  if (Test-Path -LiteralPath $destination) {
    Remove-Item -Force $destination
  }
  try {
    Move-Item -Force $stage $destination
    Assert-QuestVersion $destination "installed"
  } catch {
    if ($hadPrevious -and -not (Test-Path -LiteralPath $destination) -and (Test-Path -LiteralPath $previous)) {
      Copy-Item $previous $destination
    }
    throw
  }

  Write-Output "Installed quest $version to $destination"
  if (-not $env:QUEST_INSTALL_SKIP_PATH) {
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    if (-not $environmentKey) {
      Fail "could not open the user environment registry key"
    }
    try {
      $rawUserPath = [string]$environmentKey.GetValue(
        "Path",
        "",
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      $expandedUserPath = [string]$environmentKey.GetValue("Path", "")
      $expandedEntries = @($expandedUserPath -split ";" | Where-Object { $_ })
      if ($installDir -notin $expandedEntries) {
        $rawEntries = @($rawUserPath -split ";" | Where-Object { $_ })
        $updatedPath = (@($rawEntries) + $installDir) -join ";"
        $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($environmentKey.GetValueNames() -contains "Path") {
          $pathKind = $environmentKey.GetValueKind("Path")
        }
        if (
          $pathKind -ne [Microsoft.Win32.RegistryValueKind]::String -and
          $pathKind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString
        ) {
          Fail "the user PATH registry value is not a string"
        }
        $environmentKey.SetValue("Path", $updatedPath, $pathKind)
        Publish-EnvironmentChange
        Write-Output "Added $installDir to your user PATH. Open a new terminal before running quest."
      }
    } finally {
      $environmentKey.Dispose()
    }
  }
} finally {
  Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
