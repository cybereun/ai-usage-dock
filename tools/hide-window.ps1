param([int]$ProcId, [int]$Seconds = 30)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class HW {
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP e, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  public static void HideAll(uint pid) {
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) ShowWindow(h, 0); return true; }, IntPtr.Zero);
  }
}
'@
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { break }
  [HW]::HideAll([uint32]$ProcId)
  Start-Sleep -Milliseconds 80
}
