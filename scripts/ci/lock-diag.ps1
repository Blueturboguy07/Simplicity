# THROWAWAY diagnostic (branch probe/lock-diag, never merged).
# While the fix's retries keep failing with "system error number 13", who holds model.onnx and how?
param([int]$HoldMs = 3000, [string]$Tag = 'diag')
$ErrorActionPreference = 'Stop'
$root = $PWD
$standalone = Join-Path $root '.next\standalone'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class RM {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName; public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string k);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] f, uint na, RM_UNIQUE_PROCESS[] a, uint ns, string[] s);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] apps, ref uint reasons);
  public static string Who(string path) {
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return "rm-start-failed";
    try {
      if (RmRegisterResources(h, 1, new[]{path}, 0, null, 0, null) != 0) return "rm-register-failed";
      uint needed = 0, n = 0, reasons = 0; int r = RmGetList(h, out needed, ref n, null, ref reasons);
      if (r == 0) return "none";
      if (r != 234) return "rm-list-failed " + r;
      var arr = new RM_PROCESS_INFO[needed]; n = needed; r = RmGetList(h, out needed, ref n, arr, ref reasons);
      if (r != 0) return "rm-list2-failed " + r;
      var names = new List<string>(); for (int i = 0; i < n; i++) names.Add(arr[i].strAppName + "(" + arr[i].Process.dwProcessId + ")");
      return string.Join(",", names);
    } finally { RmEndSession(h); }
  }
}
"@
function TryOpen($p, $share) {
  try { $f = [System.IO.File]::Open($p, 'Open', 'Read', $share); $f.Close(); return 'OK' } catch { return ($_.Exception.InnerException.Message, $_.Exception.Message | Where-Object { $_ } | Select-Object -First 1) -replace '\s+', ' ' }
}
$data = Join-Path $env:RUNNER_TEMP "simplicity-$Tag"
if (Test-Path $data) { Remove-Item -Recurse -Force $data }
New-Item -ItemType Directory -Force (Join-Path $data 'data') | Out-Null
Copy-Item -Recurse -Force (Join-Path $root 'drizzle') (Join-Path $data 'drizzle')
$env:DATA_DIR = $data; $env:PORT = '3137'; $env:HOSTNAME = '127.0.0.1'; $env:NODE_ENV = 'production'
if ($HoldMs -gt 0) { $env:SIMPLICITY_CI_HOLD_MODEL_MS = "$HoldMs"; $env:NODE_OPTIONS = "--require $((Join-Path $root 'scripts\ci\hold-model-file.cjs') -replace '\\','/')" }
$err = Join-Path $root "server-$Tag.err.log"
$p = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $standalone -RedirectStandardOutput (Join-Path $root "server-$Tag.log") -RedirectStandardError $err -PassThru -NoNewWindow
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue; Remove-Item Env:SIMPLICITY_CI_HOLD_MODEL_MS -ErrorAction SilentlyContinue
$prov = $null; foreach ($i in 1..120) { try { $prov = Invoke-RestMethod 'http://127.0.0.1:3137/api/providers' -TimeoutSec 5; break } catch { Start-Sleep 1 } }
$t = $prov.providers | Where-Object { $_.type -eq 'transformers' } | Select-Object -First 1
Write-Host "DIAG server pid $($p.Id) provider $($t.id)"
$model = Join-Path $data 'models\Xenova\all-MiniLM-L6-v2\onnx\model.onnx'
$out = Join-Path $root "curl-$Tag.txt"
$curl = Start-Process -FilePath curl.exe -ArgumentList @('-s','--max-time','120','-o',$out,'-w','HTTP %{http_code}','-F',"files=@$(Join-Path $root 'scripts\ci\fixtures\notes.txt')",'-F',"embedding_model_provider_id=$($t.id)",'-F',"embedding_model_key=$($t.embeddingModels[0].key)",'http://127.0.0.1:3137/api/uploads') -PassThru -NoNewWindow
$t0 = Get-Date
while (-not $curl.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 60) {
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  if (Test-Path $model) {
    $len = (Get-Item $model).Length
    $ortStyle = TryOpen $model 'Read'
    $nodeStyle = TryOpen $model 'ReadWrite, Delete'
    $who = [RM]::Who($model)
    $ortOther = & node -e "require('onnxruntime-node').InferenceSession.create(process.argv[1]).then(()=>console.log('OK'),e=>console.log(String(e.message).replace(/^.*failed:/,'failed:')))" $model 2>&1
    Write-Host "DIAG t=${ms}ms len=$len ortStyle(FileShare.Read)=$ortStyle nodeStyle(ReadWrite+Delete)=$nodeStyle otherProcessOrt=$ortOther holders=$who"
  } else { Write-Host "DIAG t=${ms}ms model not there yet" }
  Start-Sleep -Milliseconds 700
}
$curl.WaitForExit()
Write-Host "DIAG upload: $(Get-Content $out -Raw)"
Stop-Process -Id $p.Id -Force; Start-Sleep 1
Write-Host "DIAG after server exit: ortStyle=$(TryOpen $model 'Read') holders=$([RM]::Who($model))"
Write-Host '=== server err ==='; Get-Content $err | ForEach-Object { Write-Host $_ }
