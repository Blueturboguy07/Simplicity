# CI only (.github/workflows/live-update-proof.yml, Windows runner). Not part of the app.
# What the live update proof needs from Windows: Simplicity's windows and message boxes as UI Automation sees
# them, a click on a button the way a user clicks it, the menu item "Check for Updates..." (Help menu),
# versions, processes, the DNS cache and screenshots. Each command prints one JSON value (UTF-8).
#   dump | click -Name <button> [-Title <dialog title> -Key enter|esc] | close -Name <window title> | menu
#   shot -Out <png> | version -Path <exe>
#   installed | procs | dns | dns-clear | tcp | sig -Path <file>
param(
  [Parameter(Mandatory = $true)][string]$Cmd,
  [string]$Name = '',
  [string]$Path = '',
  [string]$Out = '',
  [string]$Title = '',
  [string]$Key = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$All = [System.Windows.Automation.Condition]::TrueCondition

function Json($v) { ConvertTo-Json -Depth 6 -Compress -InputObject $v }
function AppPids { @(Get-Process -Name Simplicity -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function AppWindows {
  $ids = AppPids
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, $All)) { if ($ids -contains $w.Current.ProcessId) { $w } }
}
function Items($w) {
  $items = @()
  foreach ($e in $w.FindAll($Scope::Descendants, $All)) {
    $t = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($e.Current.Name -and @('Pane', 'Group', 'Image', 'TitleBar', 'Document', 'Custom') -notcontains $t) { $items += [pscustomobject]@{ type = $t; name = $e.Current.Name } }
  }
  , $items
}
function Buttons($w) { $w.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button))) }
Add-Type -Namespace LiveProof -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[LiveProof.Win]::SetProcessDPIAware() | Out-Null
function Key([byte]$vk) { [LiveProof.Win]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [LiveProof.Win]::keybd_event($vk, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 350 }
# A left click with the mouse in the middle of the element, as a user clicks.
function Mouse($e) {
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { return $null }
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  [LiveProof.Win]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [LiveProof.Win]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [LiveProof.Win]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  return "mouse@$x,$y"
}
# UI Automation Invoke when the element supports it, else the mouse.
function Press($e) {
  try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'invoke' } catch {}
  return (Mouse $e)
}
function Find($name, $like) {
  foreach ($w in AppWindows) {
    foreach ($e in $w.FindAll($Scope::Descendants, $All)) {
      $n = $e.Current.Name
      if (($like -and $n -like $name) -or (-not $like -and $n -eq $name)) { return $e }
    }
  }
  return $null
}

switch ($Cmd) {
  'dump' {
    $r = @(foreach ($w in AppWindows) { [pscustomobject]@{ title = $w.Current.Name; className = $w.Current.ClassName; pid = $w.Current.ProcessId; items = (Items $w) } })
    Json $r
  }
  'click' {
    # 1. a Button with that name (a command link's name starts with it), 2. any element with that name,
    # 3. the keyboard: the dialog -Title in front, then -Key (Enter = the default button, Esc = the cancel button).
    foreach ($w in AppWindows) {
      foreach ($b in Buttons $w) {
        $n = $b.Current.Name
        if ($n -eq $Name -or $n.StartsWith($Name)) { $how = Press $b; Json ([pscustomobject]@{ clicked = [bool]$how; how = "button:$how"; window = $w.Current.Name; button = $n }); exit 0 }
      }
    }
    $e = Find $Name $false
    if (-not $e) { $e = $AE::RootElement.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name))) }
    if ($e -and (AppPids) -contains $e.Current.ProcessId) { $how = Press $e; Json ([pscustomobject]@{ clicked = [bool]$how; how = "element:$($e.Current.ControlType.ProgrammaticName):$how"; button = $e.Current.Name }); exit 0 }
    if ($Title -and $Key) {
      $d = @(AppWindows | Where-Object { $_.Current.Name -eq $Title })[0]
      if (-not $d) { foreach ($w in AppWindows) { $d = $w.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Title))); if ($d) { break } } }
      if ($d) {
        if ($d.Current.NativeWindowHandle) { [LiveProof.Win]::SetForegroundWindow([IntPtr]$d.Current.NativeWindowHandle) | Out-Null }
        try { $d.SetFocus() } catch {}
        Start-Sleep -Milliseconds 400
        if ($Key -eq 'esc') { Key 0x1B } else { Key 0x0D }
        Json ([pscustomobject]@{ clicked = $true; how = "key:$Key"; window = $Title }); exit 0
      }
    }
    Json ([pscustomobject]@{ clicked = $false })
  }
  'close' {
    Key 0x1B; Key 0x1B # Esc: closes an open menu first
    foreach ($w in AppWindows) {
      if ($w.Current.Name -eq $Name) { $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); Json ([pscustomobject]@{ closed = $true }); exit 0 }
    }
    Json ([pscustomobject]@{ closed = $false })
  }
  'menu' {
    # The menu bar of the app window is hidden until Alt is pressed (autoHideMenuBar). Alt shows it; then a
    # mouse click on Help (Electron's menu bar buttons do not answer Invoke) and on "Check for Updates...".
    $w = @(AppWindows | Where-Object { $_.Current.ClassName -like 'Chrome_WidgetWin*' })[0]
    if (-not $w) { Json ([pscustomobject]@{ driven = $false; why = 'no app window' }); exit 0 }
    [LiveProof.Win]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    Key 0x12
    Start-Sleep -Milliseconds 500
    $steps = @('alt')
    $help = Find 'Help' $false
    if (-not $help) { Json ([pscustomobject]@{ driven = $false; steps = $steps; why = 'no Help in the menu bar after Alt' }); exit 0 }
    $steps += "Help:$(Mouse $help)"
    $item = $null
    for ($i = 0; $i -lt 10 -and -not $item; $i++) { Start-Sleep -Milliseconds 400; $item = Find 'Check for Updates*' $true }
    if (-not $item) { Key 0x1B; Key 0x1B; Json ([pscustomobject]@{ driven = $false; steps = $steps; why = 'the Help menu has no Check for Updates' }); exit 0 }
    $steps += "$($item.Current.Name):$(Mouse $item)"
    Json ([pscustomobject]@{ driven = $true; steps = $steps })
  }
  'shot' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    Json ([pscustomobject]@{ saved = $Out })
  }
  'version' { $v = (Get-Item -LiteralPath $Path).VersionInfo; Json ([pscustomobject]@{ product = $v.ProductVersion; file = $v.FileVersion }) }
  'installed' {
    $e = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Simplicity*' })
    Json ([pscustomobject]@{ displayVersion = ($e | ForEach-Object { $_.DisplayVersion }) -join ','; location = ($e | ForEach-Object { $_.InstallLocation }) -join ',' })
  }
  'procs' {
    $p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Simplicity*' -or $_.Name -in @('Au_.exe', 'Un_A.exe') } | ForEach-Object {
      [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath; started = $_.CreationDate.ToUniversalTime().ToString('o'); main = ($_.Name -eq 'Simplicity.exe' -and "$($_.CommandLine)" -notmatch '--type=') }
    })
    Json $p
  }
  'dns' { Json @(Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Entry -match 'publikhq|github' } | ForEach-Object { [pscustomobject]@{ entry = $_.Entry; data = $_.Data } }) }
  'dns-clear' { Clear-DnsClientCache; Json ([pscustomobject]@{ cleared = $true }) }
  'tcp' {
    $ids = AppPids
    Json @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | ForEach-Object { [pscustomobject]@{ remote = "$($_.RemoteAddress):$($_.RemotePort)"; state = "$($_.State)"; pid = $_.OwningProcess } })
  }
  'sig' { $s = Get-AuthenticodeSignature -LiteralPath $Path; Json ([pscustomobject]@{ status = "$($s.Status)"; signer = "$($s.SignerCertificate.Subject)" }) }
  default { throw "unknown command $Cmd" }
}
