<#
  RiSriGPT - one-shot setup for:
    * model server + chat app exposed on the LAN
    * Windows firewall exceptions for ports 3000 and 8080
    * autostart on Windows startup for the current user (interactive session)
      so screen capture, windows automation, and app launching work properly!

  .\install-autostart.ps1            install for current user (interactive logon)
  .\install-autostart.ps1 -AtBoot    install for machine boot (Session 0, before logon)
  .\install-autostart.ps1 -Remove    undo everything
  .\install-autostart.ps1 -LocalOnly keep both servers on 127.0.0.1 (no firewall rules)
#>
param(
  [switch]$Remove,
  [switch]$LocalOnly,
  [switch]$AtBoot,
  [switch]$StartupFolder,
  [string]$User = '',
  [int]$ChatPort = 3000,
  [int]$ModelPort = 8080
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName  = 'RiSriGPT'
$vbs       = Join-Path $root 'start-all-hidden.vbs'
$fwp       = 'RiSriGPT'

# Determine the target user (current user by default) before elevating
if (-not $User) {
  $User = "$env:USERDOMAIN\$env:USERNAME"
}

# ---------- self elevate ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $psArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$PSCommandPath`"", '-User', "`"$User`"")
  if ($Remove) { $psArgs += '-Remove' }
  if ($LocalOnly) { $psArgs += '-LocalOnly' }
  if ($AtBoot) { $psArgs += '-AtBoot' }
  if ($StartupFolder) { $psArgs += '-StartupFolder' }
  Write-Host 'Asking for administrator rights...'
  Start-Process powershell -Verb RunAs -ArgumentList $psArgs -Wait
  return
}

function remove-setup {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'"
  } else { Write-Host "Scheduled task '$taskName' not present" }
  Get-NetFirewallRule -DisplayGroup $fwp -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host "Removed firewall rules in group '$fwp'"

  $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'RiSriGPT.lnk'
  if (Test-Path $startupLnk) {
    Remove-Item -Path $startupLnk -Force -ErrorAction SilentlyContinue
    Write-Host "Removed startup shortcut: $startupLnk"
  }
}

if ($Remove) { remove-setup; return }

if (-not (Test-Path $vbs)) { throw "Missing $vbs" }

# ---------- 1. firewall ----------
if (-not $LocalOnly) {
  foreach ($port in @($ChatPort, $ModelPort)) {
    $name = "$fwp (TCP $port)"
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if (-not $existing) {
      New-NetFirewallRule -DisplayName $name -Group $fwp -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $port -Profile Any | Out-Null
      Write-Host "Firewall: allowed inbound TCP $port"
    } else {
      if ($existing.Profile -notmatch 'Any') {
        Set-NetFirewallRule -DisplayName $name -Profile Any
        Write-Host "Firewall: TCP $port rule widened to all network profiles"
      } else { Write-Host "Firewall rule already present: TCP $port" }
    }
  }
}

# ---------- 2. autostart task ----------
$action = New-ScheduledTaskAction -Execute $vbs -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4
$settings.IdleSettings.StopOnIdleEnd = $false
$settings.IdleSettings.RestartOnIdle = $false

if ($AtBoot) {
  # Boot trigger: runs at machine boot in Session 0 before user logon
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
  $desc = 'Starts the gufo model server (8080) and RiSriGPT (3000) at Windows boot (Session 0, before logon).'
  $modeDesc = 'at boot (Session 0, before logon).'
} else {
  # Logon trigger: runs when the current user logs on in an interactive session.
  # This provides full access to the interactive desktop: screen capture, windows automation,
  # window management, typing/keystrokes, and launching GUI desktop applications.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
  $desc = "Starts the gufo model server (8080) and RiSriGPT (3000, elevated) at Windows logon for $User with interactive desktop access (screen, windows automation, app launching)."
  $modeDesc = "at Windows logon for $User in an interactive session (full desktop & windows automation access)."
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $desc -Force | Out-Null
Write-Host "Scheduled task '$taskName' registered ($modeDesc)"

# Optional Startup folder shortcut
if ($StartupFolder) {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $lnkPath = Join-Path $startupDir 'RiSriGPT.lnk'
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($lnkPath)
  $shortcut.TargetPath = 'wscript.exe'
  $shortcut.Arguments = "`"$vbs`""
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = 'RiSriGPT AI Assistant'
  $shortcut.Save()
  Write-Host "Startup folder shortcut created: $lnkPath"
}

Write-Host ''
Write-Host 'Done. Start it now with:  Start-ScheduledTask -TaskName "RiSriGPT"'
Write-Host 'LAN address: ' ((Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 3 -ExpandProperty IPAddress) -join ', ')
