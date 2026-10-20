export const windowsVersionCheck = String.raw`function Test-AppVersion([string]$actual, [string]$expected) {
  return ($actual -ceq $expected -or $actual -ceq ($expected + '.0'))
}`;

export const windowsUpdateBootstrap = String.raw`param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$scriptPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($ConfigPath), 'install.ps1')
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  ('"' + $scriptPath + '"'), '-ConfigPath', ('"' + $ConfigPath + '"'))
$helper = Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe')) -ArgumentList $arguments -WindowStyle Hidden -PassThru
$helper.WaitForExit()
exit $helper.ExitCode
`;

export const windowsUpdateHelper = String.raw`param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$parentExited = $false
$failed = $false
${windowsVersionCheck}
function Write-Receipt($path, $value) {
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}
function Get-InstallScope {
  $roots = @(
    @{ Path='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope='/currentuser' },
    @{ Path='HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope='/allusers' },
    @{ Path='HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope='/allusers' }
  )
  foreach ($root in $roots) {
    $matches = @(Get-ItemProperty -Path $root.Path -ErrorAction SilentlyContinue | Where-Object {
      $_.UninstallString -and $_.UninstallString.StartsWith(('"' + $config.uninstallerPath + '"'), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 0) { return $root.Scope }
  }
  throw 'The current application is not a registered NSIS installation'
}
try {
  if (!(Test-Path -LiteralPath $config.uninstallerPath -PathType Leaf)) { throw 'NSIS uninstaller is missing' }
  $scope = Get-InstallScope
  Write-Receipt $config.readyPath @{ ready=$true }
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath $config.cancelPath) { exit 0 }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Application did not exit within 120 seconds' }
    Start-Sleep -Milliseconds 200
  }
  $parentExited = $true
  if (Test-Path -LiteralPath $config.cancelPath) { exit 0 }
  # NSIS requires the unquoted /D= argument to be last, including directories containing spaces.
  $arguments = '/S --updated ' + $scope + ' /D=' + $config.installDirectory
  $installer = Start-Process -FilePath $config.packagePath -ArgumentList $arguments -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw ('Installer exited with code ' + $installer.ExitCode) }
  $version = (Get-Item -LiteralPath $config.executablePath).VersionInfo.ProductVersion.Trim()
  if (!(Test-AppVersion $version $config.version)) { throw 'Installed application version does not match the update' }
  Write-Receipt $config.receiptPath @{ status='installed'; version=$config.version }
} catch {
  $failed = $true
  Write-Receipt $config.receiptPath @{ status='failed'; version=$config.version; message='Application update installation failed' }
} finally {
  if ($parentExited) { Remove-Item -LiteralPath $config.packagePath -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $config.jobDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
if ($parentExited -and (Test-Path -LiteralPath $config.executablePath -PathType Leaf)) {
  try { Start-Process -FilePath $config.executablePath -ArgumentList '--updated' } catch {
    $failed = $true
    Write-Receipt $config.receiptPath @{ status='failed'; version=$config.version; message='Could not reopen application' }
  }
}
if ($failed) { exit 1 }
`;
