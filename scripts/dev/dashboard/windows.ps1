# windows.ps1 - VS Code windows of the slots (module win-desktop): title, owner process, handle.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
#
# Modes:
#   -List            JSON list of visible Code.exe windows: [{ hwnd, pid, title }]
#   -Close <hwnd>    close one window politely (WM_CLOSE, like the X button: VS Code asks about unsaved files itself)
param([switch]$List, [long]$Close = 0)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class DispatcherWinW {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> All() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var s = new StringBuilder(512); GetWindowText(h, s, 512); uint pid; GetWindowThreadProcessId(h, out pid); if (s.Length > 0) r.Add(h.ToInt64() + "\t" + pid + "\t" + s.ToString()); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
if ($Close -ne 0) { [void][DispatcherWinW]::PostMessage([IntPtr]$Close, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); "ok"; exit 0 }
$code = @(Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$out = foreach ($l in [DispatcherWinW]::All()) { $a = $l -split "`t", 3; if ($code -contains [int]$a[1]) { [pscustomobject]@{ hwnd = [long]$a[0]; pid = [int]$a[1]; title = $a[2] } } }
ConvertTo-Json -Compress -InputObject @($out)
