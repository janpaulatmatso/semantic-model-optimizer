# Runs a list of single-row DAX queries on a model (read-only) and prints the results as JSON.
# Used for the referential integrity check: one query per relationship.
#   powershell -File xmla-query.ps1 -InputFile queries.json [-Database name]
# The connection string comes from the environment variable SMO_XMLA_CONN (for Power BI Desktop: localhost:port).
# queries.json: [{"key": "...", "dax": "EVALUATE ROW(...)"}, ...]  →  {"results": [{"key": "...", "values": {...}} | {"key": "...", "error": "..."}]}
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
  try {
    $results = @()
    foreach ($q in $list) {
      try {
        $cmd = $c.CreateCommand(); $cmd.CommandTimeout = 600; $cmd.CommandText = [string]$q.dax
        $r = $cmd.ExecuteReader(); $values = @{}
        try {
          if ($r.Read()) {
            for ($i = 0; $i -lt $r.FieldCount; $i++) {
              $name = $r.GetName($i) -replace '^\[|\]$', ''
              $v = $r.GetValue($i); if ($v -is [DBNull]) { $v = $null } elseif ($v -is [decimal] -or $v -is [long] -or $v -is [int]) { $v = [double]$v }
              $values[$name] = $v
            }
          }
        } finally { $r.Close() }
        $results += , @{ key = $q.key; values = $values }
      } catch {
        $msg = $_.Exception.Message; if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
        $results += , @{ key = $q.key; error = ($msg -split "`n")[0].Trim() }
      }
    }
    Out-Json @{ results = @($results) }
  } finally { $c.Close() }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $msg + ' ' + $_.Exception.InnerException.Message }
  Out-Json @{ error = 'Checking the data failed: ' + $msg }
}
