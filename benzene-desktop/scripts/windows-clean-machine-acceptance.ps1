[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string] $InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string] $ExpectedSha256,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9 ]{40,64}$')]
  [string] $ExpectedSignerThumbprint,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedAppOrigin,

  [Parameter(Mandatory = $true)]
  [string] $ExpectedGatewayOrigin
)

$ErrorActionPreference = 'Stop'

function Assert-Equal([string] $Actual, [string] $Expected, [string] $Label) {
  if ($Actual -cne $Expected) {
    throw "$Label did not match the expected value. Expected '$Expected'; received '$Actual'."
  }
}

function ConvertTo-HttpsOrigin([string] $Value, [string] $Label) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -or
    $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
    throw "$Label must be an HTTPS origin without credentials, path, query, or fragment."
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

function Get-AgentProcess([string] $AgentScriptPath, [string] $ExecutablePath) {
  $normalizedScript = [IO.Path]::GetFullPath($AgentScriptPath)
  $normalizedExe = [IO.Path]::GetFullPath($ExecutablePath)
  return Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $normalizedExe -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($normalizedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | Select-Object -First 1
}

function Wait-AgentProcess([string] $AgentScriptPath, [string] $ExecutablePath, [int] $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $agent = Get-AgentProcess $AgentScriptPath $ExecutablePath
    if ($agent) { return $agent }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Wait-ProcessExit([int] $ProcessId, [int] $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

if (-not $env:LOCALAPPDATA -or -not $env:APPDATA) {
  throw 'This acceptance script must run in an interactive Windows user session.'
}
$appOrigin = ConvertTo-HttpsOrigin $ExpectedAppOrigin 'Expected Vault app address'
$gatewayOrigin = ConvertTo-HttpsOrigin $ExpectedGatewayOrigin 'Expected gateway address'

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Assert-Equal $installerHash.ToUpperInvariant() $ExpectedSha256.ToUpperInvariant() 'Installer SHA-256'

$signature = Get-AuthenticodeSignature -FilePath $installer
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
  throw "Installer Authenticode signature must be Valid; received '$($signature.Status)'."
}
$actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
$expectedThumbprint = ($ExpectedSignerThumbprint -replace '\s', '').ToUpperInvariant()
Assert-Equal $actualThumbprint $expectedThumbprint 'Installer signer thumbprint'

$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $env:LOCALAPPDATA "BenzeneAcceptance\$runId"
$installDir = Join-Path $runRoot 'install'
$reportPath = Join-Path $runRoot 'acceptance-report.json'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

$installerProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=`"$installDir`"") -Wait -PassThru
if ($installerProcess.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($installerProcess.ExitCode)."
}

$application = Get-ChildItem -LiteralPath $installDir -Filter 'Benzene.exe' -File -Recurse | Select-Object -First 1
if (-not $application) { throw 'Benzene.exe was not installed under the isolated acceptance directory.' }
$applicationPath = $application.FullName
$resourcesDir = Join-Path (Split-Path $applicationPath -Parent) 'resources'
$agentScript = Join-Path $resourcesDir 'node-agent.cjs'
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) {
  throw 'The installed app is missing resources\node-agent.cjs; the independent agent was not packaged.'
}

$report = [ordered]@{
  status = 'in_progress'
  testedAtUtc = [DateTime]::UtcNow.ToString('o')
  windowsUser = [Environment]::UserName
  installerSha256 = $installerHash.ToUpperInvariant()
  signerThumbprint = $actualThumbprint
  applicationPath = $applicationPath
  agentResourcePath = $agentScript
  expectedAppOrigin = $appOrigin
  expectedGatewayOrigin = $gatewayOrigin
  completedChecks = @('sha256', 'authenticode', 'expected_signer', 'isolated_install', 'packaged_agent_resource')
}

try {
  $ui = Start-Process -FilePath $applicationPath -PassThru
  Write-Host 'Benzene has opened. Confirm the first-run setup shows the expected Vault and gateway origins, then connect it to a dedicated test Vault.'
  Write-Host 'Approve the displayed computer pairing code in the Devices page. Do not use a Vault containing important data.'
  [void](Read-Host 'After this computer is approved and visible as online, press Enter to check agent independence')

  $agent = Wait-AgentProcess $agentScript $applicationPath 30
  if (-not $agent) {
    throw 'The packaged node agent did not appear as a separate process after setup. Check the Benzene agent log and installer package.'
  }
  $agentPid = [int] $agent.ProcessId
  if ($agentPid -eq $ui.Id) { throw 'The node agent is not running as a separate operating-system process.' }
  $report.completedChecks += 'first_run_setup_and_pairing'
  $report.completedChecks += 'separate_agent_process'
  $report.agentProcessId = $agentPid

  Write-Host 'Use Benzene > Quit to close the desktop window. The agent should remain online.'
  [void](Read-Host 'After the desktop window closes, press Enter to verify the agent remains running')
  if (-not (Wait-ProcessExit $ui.Id 30)) {
    throw 'The original Benzene desktop process did not exit after the window was quit.'
  }
  $agentAfterQuit = Get-AgentProcess $agentScript $applicationPath
  if (-not $agentAfterQuit -or [int] $agentAfterQuit.ProcessId -ne $agentPid) {
    throw 'The independent node agent did not survive closing the desktop window.'
  }
  $report.completedChecks += 'agent_survives_ui_quit'

  $reopened = Start-Process -FilePath $applicationPath -PassThru
  Start-Sleep -Seconds 5
  $agentAfterRestart = Get-AgentProcess $agentScript $applicationPath
  if (-not $agentAfterRestart -or [int] $agentAfterRestart.ProcessId -ne $agentPid) {
    throw 'Restarting the desktop did not reuse the existing node agent process.'
  }
  $report.completedChecks += 'desktop_reopen_reuses_agent'
  $report.desktopRestartProcessId = [int] $reopened.Id
  $report.agentProcessIdAfterRestart = [int] $agentAfterRestart.ProcessId

  Write-Host 'Confirm the approved device remains online after reopening Benzene. Then quit the desktop window.'
  [void](Read-Host 'Press Enter after confirming the device is online')
  $report.status = 'passed'
  $report.completedAtUtc = [DateTime]::UtcNow.ToString('o')
} catch {
  $report.status = 'failed'
  $report.failure = $_.Exception.Message
  $report.completedAtUtc = [DateTime]::UtcNow.ToString('o')
  throw
} finally {
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host "Acceptance evidence: $reportPath"
  Write-Host 'The installer, installed app, application data, and agent storage are retained for inspection; this script does not uninstall or delete them.'
}
