<#
  slot-windows.ps1 - arrange the VS Code slot windows into a grid (module win-desktop).

  NOTE: this file is ASCII-only on purpose. Windows PowerShell 5.1 reads a script
  without a BOM as ANSI, so non-ASCII text in comments or patterns would be corrupted.

  Slot windows are found by TITLE: slot-workspaces.mjs titles them
  "[<tag> <title>] <branch> - <file>", e.g. "[S1 Search] dev/wv-0001-search".
  The default pattern '^\[\S*\d\s' matches the "[<tag><digit> " prefix.

  Default mode is LIST: it only prints what it found, nothing is moved.
  Moving needs -Apply.

  Examples (from the dispatcher folder):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/slot-windows.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/slot-windows.ps1 -Apply
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/slot-windows.ps1 -Apply -Rows 2 -Columns 2 -LeftReserve 0

  -Columns  columns in the grid (0 = as many as windows, one row)
  -Rows     rows in the grid (default 1)
  -LeftReserve  fraction of the screen width left free on the left for your main
            window (default 0.2; 0 = use the whole screen)
  -Pattern  regex for the window title
#>
param(
  [switch]$Apply,
  [int]$Columns = 0,
  [int]$Rows = 1,
  [double]$LeftReserve = 0.2,
  [string]$Pattern = '^\[\S*\d\s'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SlotW32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // Electron (VS Code) top-level windows have the class Chrome_WidgetWin_1.
  public static List<KeyValuePair<IntPtr, string>> Find() {
    List<KeyValuePair<IntPtr, string>> found = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(64);
      GetClassName(h, c, 64);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      StringBuilder t = new StringBuilder(512);
      GetWindowText(h, t, 512);
      if (t.Length > 0) found.Add(new KeyValuePair<IntPtr, string>(h, t.ToString()));
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -AssemblyName System.Windows.Forms

[void][SlotW32]::SetProcessDPIAware()

$all = [SlotW32]::Find()
$slots = @($all | Where-Object { $_.Value -match $Pattern } | Sort-Object { $_.Value })

"Found {0} slot window(s) of {1} VS Code window(s):" -f $slots.Count, $all.Count
foreach ($w in $slots) { "  " + $w.Value }

if ($slots.Count -eq 0) { "Nothing matches the pattern '$Pattern'. Open the slot windows first."; exit 0 }
if (-not $Apply) { "List only. Add -Apply to arrange them."; exit 0 }

if ($LeftReserve -lt 0 -or $LeftReserve -ge 0.9) { throw "LeftReserve must be in [0, 0.9)" }
if ($Rows -lt 1) { throw "Rows must be >= 1" }
$cols = if ($Columns -gt 0) { $Columns } else { [int][math]::Ceiling($slots.Count / $Rows) }
if ($cols * $Rows -lt $slots.Count) { throw "A $cols x $Rows grid does not fit $($slots.Count) windows" }

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x0 = $wa.X + [int]($wa.Width * $LeftReserve)
$cw = [int](($wa.Right - $x0) / $cols)
$ch = [int]($wa.Height / $Rows)

# SWP_NOZORDER (0x0004) | SWP_SHOWWINDOW (0x0040); SW_RESTORE = 9 un-maximizes first
for ($i = 0; $i -lt $slots.Count; $i++) {
  $r = [math]::Floor($i / $cols)
  $c = $i % $cols
  [void][SlotW32]::ShowWindow($slots[$i].Key, 9)
  [void][SlotW32]::SetWindowPos($slots[$i].Key, [IntPtr]::Zero, $x0 + $c * $cw, $wa.Y + $r * $ch, $cw, $ch, 0x0044)
}
"Arranged {0} window(s) in a {1} x {2} grid on the work area {3}x{4}." -f $slots.Count, $cols, $Rows, $wa.Width, $wa.Height
