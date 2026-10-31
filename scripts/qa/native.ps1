param(
    [ValidateSet("inspect", "click", "set", "capture")][string]$Action = "inspect",
    [string]$Name = "",
    [string]$Value = "",
    [string]$Output = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QaWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    public struct Rect { public int Left, Top, Right, Bottom; }
}
"@
$process = Get-Process cmdc-gui | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (!$process) { throw "No native cmdc-gui window" }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
if ($Action -eq "inspect") {
    $all | ForEach-Object {
        if ($_.Current.Name) { [pscustomobject]@{ Name = $_.Current.Name; Type = $_.Current.ControlType.ProgrammaticName; Enabled = $_.Current.IsEnabled } }
    } | ConvertTo-Json -Depth 3
    exit 0
}
if ($Action -eq "click" -or $Action -eq "set") {
    $element = $all | Where-Object { $_.Current.Name -eq $Name -and $_.Current.IsEnabled } | Select-Object -First 1
    if (!$element) { throw "Accessible element not found: $Name" }
    if ($Action -eq "click") {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            $pattern.Select()
        } else { throw "No invoke or selection pattern: $Name" }
    } else {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $pattern.SetValue($Value)
        $fresh = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
        $readback = $fresh.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
        if ($readback -ne $Value) { throw "Value readback failed: actual=[$readback]" }
    }
    Write-Output "ACTION_OK $Action $Name"
}
if ($Output) {
    [QaWindow]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
    [QaWindow]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    $r = New-Object QaWindow+Rect
    [QaWindow]::GetWindowRect($process.MainWindowHandle, [ref]$r) | Out-Null
    $image = New-Object System.Drawing.Bitmap(($r.Right-$r.Left), ($r.Bottom-$r.Top))
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    try {
        $graphics.CopyFromScreen($r.Left,$r.Top,0,0,$image.Size)
        $image.Save($Output,[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $image.Dispose() }
    Write-Output "CAPTURE_OK $Output"
}
