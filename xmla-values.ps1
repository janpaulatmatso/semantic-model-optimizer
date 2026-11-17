# Calculates the grand total of a list of measures on a model (read-only) and prints the results as JSON.
# Used to compare what measures return before and after a change, and to find measures the engine cannot calculate.
#   powershell -File xmla-values.ps1 -InputFile measures.json [-Database name]
# The connection string comes from the environment variable SMO_XMLA_CONN (for Power BI Desktop: localhost:port).
# measures.json: [{"table": "Sales", "name": "Revenue"}, ...]
param([string]$InputFile = '', [string]$Database = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($o) { $o | ConvertTo-Json -Depth 6 -Compress }
try {
  $conn = $env:SMO_XMLA_CONN
  if (-not $conn) { Out-Json @{ error = 'No server given.' }; exit 0 }
  if ($conn -notmatch '=') { $conn = "Data Source=$conn" }
  if ($Database -and $conn -notmatch '(?i)initial catalog\s*=') { $conn = "$conn;Initial Catalog=$Database" }
  $list = @((Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ })
  $candidates = @($env:SMO_ADOMD) + @(
    "$env:ProgramFiles\DAX Studio\bin\Microsoft.AnalysisServices.AdomdClient.dll",
    "$env:ProgramFiles\Tabular Editor 3\Microsoft.AnalysisServices.AdomdClient.dll",
    "${env:ProgramFiles(x86)}\Tabular Editor\Microsoft.AnalysisServices.AdomdClient.dll"
  ) + @(Get-ChildItem "$env:windir\Microsoft.NET\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient" -Recurse -Filter *.dll -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName)
  $dll = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $dll) { Out-Json @{ error = 'ADOMD.NET not found. Install DAX Studio (it ships with it).' }; exit 0 }
  Add-Type -Path $dll
  $c = New-Object Microsoft.AnalysisServices.AdomdClient.AdomdConnection($conn)
  $c.Open()
  function Run($items) {
    # one query for a group of measures; throws when any of them fails
    $parts = for ($i = 0; $i -lt $items.Count; $i++) { '"m' + $i + '", [' + ([string]$items[$i].name).Replace(']', ']]') + ']' }
    $cmd = $c.CreateCommand(); $cmd.CommandTimeout = 300; $cmd.CommandText = 'EVALUATE ROW(' + ($parts -join ', ') + ')'
    $r = $cmd.ExecuteReader(); $out = @()
    try {
      if ($r.Read()) { for ($i = 0; $i -lt $items.Count; $i++) { $v = $r.GetValue($i); if ($v -is [DBNull]) { $v = $null } elseif ($v -is [DateTime]) { $v = $v.ToString('s') } elseif ($v -is [decimal]) { $v = [double]$v }; $out += , @{ table = $items[$i].table; name = $items[$i].name; value = $v } } }
    } finally { $r.Close() }
    $out
  }
  try {
    $results = @(); $size = 15
    for ($s = 0; $s -lt $list.Count; $s += $size) {
      $group = @($list[$s..([Math]::Min($s + $size, $list.Count) - 1)])
      try { $results += Run $group }
      catch {
        # find the measure(s) that fail by running them one at a time
        foreach ($m in $group) {
          try { $results += Run @($m) }
          catch { $msg = $_.Exception.Message; if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }; $results += , @{ table = $m.table; name = $m.name; error = ($msg -split "`n")[0].Trim() } }
        }
      }
    }
    Out-Json @{ values = @($results) }
  } finally { $c.Close() }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $msg + ' ' + $_.Exception.InnerException.Message }
  Out-Json @{ error = 'Calculating failed: ' + $msg }
}
