param([string]$Exe, [string]$OutDir)
Add-Type -AssemblyName System.Drawing
function Draw([int]$n) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $r = $n * 0.22
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2; $m = $n * 0.03; $w = $n - 2 * $m
  $path.AddArc($m, $m, $d, $d, 180, 90); $path.AddArc($m + $w - $d, $m, $d, $d, 270, 90)
  $path.AddArc($m + $w - $d, $m + $w - $d, $d, $d, 0, 90); $path.AddArc($m, $m + $w - $d, $d, $d, 90, 90); $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new($n, $n)), ([System.Drawing.Color]::FromArgb(255, 255, 255, 255)), ([System.Drawing.Color]::FromArgb(255, 226, 234, 250))
  $g.FillPath($bg, $path)
  $cx = $n / 2; $cy = $n / 2
  $rings = @(@(0.36, 'FF60A5FA', 0.82), @(0.25, 'FFF59E0B', 0.62), @(0.14, 'FF34D399', 0.42))
  foreach ($ri in $rings) {
    $rad = $n * $ri[0]; $pw = [Math]::Max(1.5, $n * 0.075)
    $track = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 226, 231, 242)), $pw
    $g.DrawEllipse($track, $cx - $rad, $cy - $rad, 2 * $rad, 2 * $rad)
    $c = [System.Drawing.ColorTranslator]::FromHtml('#' + $ri[1].Substring(2))
    $pen = New-Object System.Drawing.Pen $c, $pw
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $g.DrawArc($pen, $cx - $rad, $cy - $rad, 2 * $rad, 2 * $rad, -90, 360 * $ri[2])
  }
  $g.Dispose(); return $bmp
}
$sizes = 256, 64, 48, 32, 16
$pngs = @()
foreach ($s in $sizes) { $b = Draw $s; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $pngs += , $ms.ToArray(); if ($s -eq 256) { $b.Save("$OutDir\icon.png") } }
# ICO 작성
$ms = New-Object System.IO.MemoryStream; $bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $wb = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$wb); $bw.Write([byte]$wb); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$off); $off += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
[IO.File]::WriteAllBytes("$OutDir\icon.ico", $ms.ToArray())
if (-not $Exe) { return }
# exe 아이콘 교체 (Win32 UpdateResource)
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public class Res {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr BeginUpdateResource(string f,bool d);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool UpdateResource(IntPtr h,IntPtr t,IntPtr n,ushort l,byte[] d,uint c);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h,bool d);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr LoadLibraryEx(string f,IntPtr h,uint fl);
 [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr h);
 public delegate bool EnumProc(IntPtr m,IntPtr t,IntPtr n,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool EnumResourceNames(IntPtr m,IntPtr t,EnumProc c,IntPtr p);
 public static List<long> Names(string file,int type){ var l=new List<long>(); IntPtr m=LoadLibraryEx(file,IntPtr.Zero,2); EnumResourceNames(m,(IntPtr)type,(a,b,c,d)=>{l.Add((long)c);return true;},IntPtr.Zero); FreeLibrary(m); return l; }
}
'@
$groups = [Res]::Names($Exe, 14)
$h = [Res]::BeginUpdateResource($Exe, $false)
# 새 RT_ICON 들 (id 100+)
for ($i = 0; $i -lt $sizes.Count; $i++) { [void][Res]::UpdateResource($h, [IntPtr]3, [IntPtr](100 + $i), 1033, $pngs[$i], $pngs[$i].Length) }
$gm = New-Object System.IO.MemoryStream; $gw = New-Object System.IO.BinaryWriter $gm
$gw.Write([uint16]0); $gw.Write([uint16]1); $gw.Write([uint16]$sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $wb = if ($s -ge 256) { 0 } else { $s }
  $gw.Write([byte]$wb); $gw.Write([byte]$wb); $gw.Write([byte]0); $gw.Write([byte]0); $gw.Write([uint16]1); $gw.Write([uint16]32); $gw.Write([uint32]$pngs[$i].Length); $gw.Write([uint16](100 + $i))
}
$gb = $gm.ToArray()
foreach ($n in $groups) { [void][Res]::UpdateResource($h, [IntPtr]14, [IntPtr]$n, 1033, $gb, $gb.Length) }
[void][Res]::EndUpdateResource($h, $false)
"groups: $($groups -join ',')"
