<#
  RiSriGPT - one-shot setup for:
    * model server + chat app exposed on the LAN
    * Windows firewall exceptions for ports 3000 and 8080
    * autostart at every Windows boot (Scheduled Task, runs before logon)

  .\install-autostart.ps1            install (prompts once for admin)
  .\install-autostart.ps1 -Remove    undo everything
  .\install-autostart.ps1 -LocalOnly keep both servers on 127.0.0.1 (no firewall rules)
#>
param(
  [switch]$Remove,
  [switch]$LocalOnly,
  [int]$ChatPort = 3000,
  [int]$ModelPort = 8080
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName  = 'RiSriGPT'
$vbs       = Join-Path $root 'start-all-hidden.vbs'
$fwp       = 'RiSriGPT'

# ---------- self elevate ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $psArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$PSCommandPath`"")
  if ($Remove) { $psArgs += '-Remove' }
  if ($LocalOnly) { $psArgs += '-LocalOnly' }
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
}

if ($Remove) { remove-setup; return }

if (-not (Test-Path $vbs)) { throw "Missing $vbs" }

# ---------- 1. model server ----------
# Nothing to patch: start-model.bat runs gufo.exe with --host 0.0.0.0 directly.

# ---------- 2. firewall ----------
if (-not $LocalOnly) {
  foreach ($port in @($ChatPort, $ModelPort)) {
    $name = "$fwp (TCP $port)"
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if (-not $existing) {
      # Profile Any: a Wi-Fi/Ethernet connection that Windows classifies as "Public"
      # would otherwise block every LAN client.
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

# ---------- 3. run at every boot ----------
$action  = New-ScheduledTaskAction -Execute $vbs -WorkingDirectory $root
# Boot triggers have no RandomDelay property (only time-based triggers do), so the
# 30 s grace period for the network lives in start-all.bat instead.
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description `
  'Starts the gufo model server (8080) and RiSriGPT (3000, as admin) at Windows startup.' -Force | Out-Null
Write-Host "Scheduled task '$taskName' registered (runs at boot, before logon)."

Write-Host ''
Write-Host 'Done. Start it now with:  Start-ScheduledTask -TaskName "RiSriGPT"'
Write-Host 'LAN address: ' ((Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 3 -ExpandProperty IPAddress) -join ', ')