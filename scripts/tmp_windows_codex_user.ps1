# Measurement only (throwaway branch). The runner's account is elevated, and
# `codex app-server daemon start` refuses an elevated token, so a standard local
# user runs the Codex part through a scheduled task.
$ErrorActionPreference = "Continue"
$root = "C:\ap"
New-Item -ItemType Directory -Force $root | Out-Null
$user = "accprobe"
$pw = "Ap-" + ([guid]::NewGuid().ToString("N").Substring(0, 20)) + "!9"
net user $user $pw /add | Out-Host

# A scheduled task with a stored password logs on as a batch job.
secedit /export /cfg "$root\sec.inf" /areas USER_RIGHTS | Out-Null
$sid = (New-Object System.Security.Principal.NTAccount($user)).Translate(
  [System.Security.Principal.SecurityIdentifier]).Value
$inf = Get-Content "$root\sec.inf"
if ($inf -match '^SeBatchLogonRight') {
  $inf = $inf -replace '^(SeBatchLogonRight\s*=\s*.*)$', "`$1,*$sid"
} else {
  $inf = $inf -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`nSeBatchLogonRight = *$sid"
}
Set-Content "$root\sec.inf" $inf -Encoding Unicode
secedit /configure /db "$root\sec.sdb" /cfg "$root\sec.inf" /areas USER_RIGHTS | Out-Host

$repo = (Get-Location).Path
$node = (Get-Command node).Source
$codex = (Get-Command codex).Source
icacls $root /grant "${user}:(OI)(CI)F" | Out-Null
foreach ($dir in @($repo, (Split-Path $codex), (Split-Path $node))) {
  icacls $dir /grant "${user}:(OI)(CI)RX" /T /Q | Out-Null
}
Write-Host "node: $node codex: $codex repo: $repo"

Set-Content "$root\run.cmd" @"
@echo off
set "CODEX_HOME=C:\ap\cx"
set "ACC_PROBE_CODEX=$codex"
set "PATH=$(Split-Path $codex);$(Split-Path $node);%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\WindowsPowerShell\v1.0"
"$node" "$repo\scripts\tmp_windows_codex_user.mjs" > "C:\ap\out.log" 2>&1
echo done > "C:\ap\done.txt"
"@

schtasks /create /tn accprobe /tr "cmd /d /c C:\ap\run.cmd" /sc once /st 23:59 /ru $user /rp $pw /rl LIMITED /f | Out-Host
schtasks /run /tn accprobe | Out-Host
for ($i = 0; $i -lt 600 -and -not (Test-Path "$root\done.txt"); $i++) { Start-Sleep 1 }
Write-Host "--- inner log:"
Get-Content "$root\out.log" -ErrorAction SilentlyContinue | Out-Host
schtasks /query /tn accprobe /v /fo list | Select-String "Last Result|Status|Run As" | Out-Host
