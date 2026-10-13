# Stops this repo's bridge (supervisor.js and bridge.js) and writes bridge\KILLED.
# -ListOnly prints the matching process ids instead and changes nothing.
param([switch]$ListOnly)
$ErrorActionPreference = 'SilentlyContinue'

$bridgeDir = [IO.Path]::GetFullPath($PSScriptRoot)
$repoDir = [IO.Path]::GetFullPath((Split-Path -Parent $bridgeDir))
$targets = @(
    [IO.Path]::GetFullPath((Join-Path $bridgeDir 'supervisor.js')),
    [IO.Path]::GetFullPath((Join-Path $bridgeDir 'bridge.js'))
)

if (-not ('CommandLineParser' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CommandLineParser {
    // Unicode: without it the command line is passed as ANSI bytes and never parses,
    // so no process matched and the bridge was never stopped.
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@
}

$candidates = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
foreach ($process in $candidates) {
    $argc = 0
    $argvPointer = [CommandLineParser]::CommandLineToArgvW([string]$process.CommandLine, [ref]$argc)
    if (-not $argvPointer) { continue }
    try {
        $argv = @()
        for ($i = 0; $i -lt $argc; $i++) {
            $itemPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($argvPointer, $i * [IntPtr]::Size)
            $argv += [Runtime.InteropServices.Marshal]::PtrToStringUni($itemPointer)
        }
    } finally {
        [void][CommandLineParser]::LocalFree($argvPointer)
    }

    $entrypoint = $null
    for ($i = 1; $i -lt $argv.Count; $i++) {
        if (-not $argv[$i].StartsWith('-')) {
            $entrypoint = $argv[$i]
            break
        }
    }
    if (-not $entrypoint) { continue }

    try {
        if ([IO.Path]::IsPathRooted($entrypoint)) {
            $resolved = [IO.Path]::GetFullPath($entrypoint)
        } else {
            $resolved = [IO.Path]::GetFullPath((Join-Path $repoDir $entrypoint))
        }
    } catch {
        continue
    }
    if ($targets -contains $resolved) {
        if ($ListOnly) { Write-Output $process.ProcessId; continue }
        # A bridge window (start-window.cmd, the launcher) is a "cmd /k node ...supervisor.js"
        # that would stay open at a prompt: stop that cmd instead, which takes node with it.
        $victim = $process.ProcessId
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
        if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -like '*supervisor.js*') { $victim = $parent.ProcessId }
        # /T: the agents the bridge started die with it.
        & taskkill.exe /PID $victim /T /F | Out-Null
    }
}

if ($ListOnly) { exit 0 }

$killedPath = Join-Path $bridgeDir 'KILLED'
$payload = @{ at = [DateTime]::UtcNow.ToString('o'); by = 'runback-kill' } | ConvertTo-Json -Compress
Set-Content -LiteralPath $killedPath -Value $payload -NoNewline -Encoding UTF8
