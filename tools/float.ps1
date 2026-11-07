Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinTop {
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) {
  Write-Host '没有找到 Edge 浏览器，无法打开悬浮窗。'
  Start-Sleep 3
  exit 1
}

$url = 'http://127.0.0.1:8765/?mini=1'
try { $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/' -TimeoutSec 3 }
catch {
  Write-Host '服务没开。请先双击「启动助手.bat」，等黑窗口出现后再开悬浮窗。'
  Start-Sleep 5
  exit 1
}

$before = @()
try { $before = (Get-Process msedge -ErrorAction SilentlyContinue).Id } catch { }

Start-Process -FilePath $edge -ArgumentList "--app=$url", '--window-size=400,620', '--window-position=40,40'
Start-Sleep -Seconds 4

$targets = @()
try {
  $targets = Get-Process msedge -ErrorAction SilentlyContinue |
    Where-Object { ($before -notcontains $_.Id) -and $_.MainWindowHandle -ne 0 }
} catch { }

$HWND_TOPMOST = [IntPtr](-1)
$SWP = 0x0043   # NOSIZE | NOMOVE | SHOWWINDOW

foreach ($p in $targets) {
  $h = $p.MainWindowHandle
  [void][WinTop]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP)
  [void][WinTop]::SetForegroundWindow($h)
}

if ($targets.Count -eq 0) {
  Write-Host '窗口开出来了，但没能把它固定在最上面（可以手动拖动窗口，不影响使用）。'
} else {
  Write-Host '悬浮窗已打开，并且固定在最前面。关掉这个窗口就是关闭悬浮窗。'
}
Start-Sleep -Seconds 2
