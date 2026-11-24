# monitor.ps1 - one snapshot of this Windows machine for the dispatcher monitor (module win-desktop).
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
#
# Prints one JSON object: processes (tree, command line, memory, start time), CPU load per process,
# visible VS Code windows (title -> workspace -> slot) and OS memory including the commit limit.
# Parsed by monitor-win.mjs (analyzeSample). One call per minute instead of several small samplers:
# every PowerShell start is expensive.
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class DispatcherMonW {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> All() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var s = new StringBuilder(512); GetWindowText(h, s, 512); uint pid; GetWindowThreadProcessId(h, out pid); if (s.Length > 0) r.Add(h.ToInt64() + "\t" + pid + "\t" + s.ToString()); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, @{ n = "Created"; e = { if ($_.CreationDate) { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } } })
$perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.PercentProcessorTime -gt 0 -and $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Select-Object Name, IDProcess, PercentProcessorTime)
$code = @($procs | Where-Object { $_.Name -eq 'Code.exe' } | ForEach-Object { [int]$_.ProcessId })
$wins = @(foreach ($l in [DispatcherMonW]::All()) { $a = $l -split "`t", 3; if ($code -contains [int]$a[1]) { [pscustomobject]@{ hwnd = [long]$a[0]; title = $a[2] } } })
$o = Get-CimInstance Win32_OperatingSystem
$mem = @{ freeCommitKB = [long]$o.FreeVirtualMemory; totalCommitKB = [long]$o.TotalVirtualMemorySize; freePhysKB = [long]$o.FreePhysicalMemory; totalPhysKB = [long]$o.TotalVisibleMemorySize }
@{ procs = $procs; perf = $perf; windows = $wins; mem = $mem } | ConvertTo-Json -Compress -Depth 4
