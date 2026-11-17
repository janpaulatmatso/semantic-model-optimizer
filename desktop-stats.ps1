# Reads row counts and memory usage from a file open in Power BI Desktop (read-only).
#   powershell -File desktop-stats.ps1 -List         -> open files with their port
#   powershell -File desktop-stats.ps1 -Port 12345   -> statistics as JSON
# With a connection string in the environment variable SMO_XMLA_CONN (and -Database) it reads from that server instead.
# Requires ADOMD.NET, which ships with DAX Studio, Tabular Editor and SSMS, among others.
param([switch]$List, [int]$Port = 0, [string]$Database = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($o) { $o | ConvertTo-Json -Depth 6 -Compress }

function Get-Instances {
  $procs = Get-CimInstance Win32_Process -Filter "Name='msmdsrv.exe'"
  foreach ($p in $procs) {
    $parent = Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue
    if (-not $parent -or $parent.ProcessName -ne 'PBIDesktop') { continue }
    $port = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in '127.0.0.1', '::1' } | Select-Object -First 1 -ExpandProperty LocalPort
    if (-not $port) { continue }
    $title = $parent.MainWindowTitle -replace '\s+-\s+Power BI Desktop.*$', ''
    $file = ''
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue).CommandLine
    if ($cl -match '"([^"]+\.(pbip|pbix|pbit))"') { $file = $Matches[1] } elseif ($cl -match '\s(\S+\.(pbip|pbix|pbit))\s*$') { $file = $Matches[1] }
    if ($file) { $title = [System.IO.Path]::GetFileNameWithoutExtension($file) }
    if (-not $title) { $title = "Power BI Desktop ($($parent.Id))" }
    [pscustomobject]@{ port = [int]$port; name = $title; file = $file }
  }
}

if ($List) { Out-Json @{ instances = @(Get-Instances) }; exit 0 }

$remote = $env:SMO_XMLA_CONN
$instances = @()
if (-not $remote) { $instances = @(Get-Instances) }
if (-not $remote -and -not ($instances | Where-Object { $_.port -eq $Port })) {
  Out-Json @{ error = 'This is not the port of a file open in Power BI Desktop.' }; exit 0
}

$candidates = @($env:SMO_ADOMD) + @(
  "$env:ProgramFiles\DAX Studio\bin\Microsoft.AnalysisServices.AdomdClient.dll",
  "$env:ProgramFiles\Tabular Editor 3\Microsoft.AnalysisServices.AdomdClient.dll",
  "${env:ProgramFiles(x86)}\Tabular Editor\Microsoft.AnalysisServices.AdomdClient.dll"
) + @(Get-ChildItem "$env:windir\Microsoft.NET\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient" -Recurse -Filter *.dll -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | ForEach-Object FullName)
$dll = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $dll) {
  Out-Json @{ error = 'ADOMD.NET not found. Install DAX Studio, or export a .vpax from it (Advanced > Export Metrics) and load that.' }; exit 0
}
Add-Type -Path $dll

$connStr = "Data Source=localhost:$Port"
if ($remote) { $connStr = $remote; if ($connStr -notmatch '=') { $connStr = "Data Source=$connStr" }; if ($Database -and $connStr -notmatch '(?i)initial catalog\s*=') { $connStr = "$connStr;Initial Catalog=$Database" } }
$conn = New-Object Microsoft.AnalysisServices.AdomdClient.AdomdConnection($connStr)
$conn.Open()
function Query($sql) {
  $cmd = $conn.CreateCommand(); $cmd.CommandText = $sql
  $r = $cmd.ExecuteReader(); $rows = @()
  while ($r.Read()) { $o = @{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $o[$r.GetName($i)] = $r.GetValue($i) }; $rows += $o }
  $r.Close(); $rows
}
try {
  $tables = @{}; $columns = @{}
  $colName = @{}   # "table|COLUMN_ID" -> column name
  foreach ($c in Query 'SELECT DIMENSION_NAME, COLUMN_ID, ATTRIBUTE_NAME, DICTIONARY_SIZE, COLUMN_TYPE FROM $SYSTEM.DISCOVER_STORAGE_TABLE_COLUMNS') {
    if ($c.COLUMN_TYPE -ne 'BASIC_DATA') { continue }
    $t = [string]$c.DIMENSION_NAME; $n = [string]$c.ATTRIBUTE_NAME
    if ($n -like 'RowNumber-*') { continue }
    $colName["$t|$($c.COLUMN_ID)"] = $n
    $columns["$t|$n"] = @{ table = $t; name = $n; dictionary = [long]$c.DICTIONARY_SIZE; data = [long]0; hierarchy = [long]0; cardinality = $null }
  }
  foreach ($t in Query 'SELECT DIMENSION_NAME, TABLE_ID, ROWS_COUNT FROM $SYSTEM.DISCOVER_STORAGE_TABLES') {
    $d = [string]$t.DIMENSION_NAME; $id = [string]$t.TABLE_ID
    if ($id -match '^H\$.*\$(.+)$') {
      $k = "$d|" + $colName["$d|$($Matches[1])"]
      if ($columns.ContainsKey($k)) { $columns[$k].cardinality = [Math]::Max(0, [long]$t.ROWS_COUNT - 3) }
    } elseif ($id -notmatch '^[RU]\$') {
      $tables[$d] = @{ name = $d; rows = [long]$t.ROWS_COUNT; size = [long]0; other = [long]0 }
    }
  }
  foreach ($s in Query 'SELECT DIMENSION_NAME, TABLE_ID, COLUMN_ID, USED_SIZE FROM $SYSTEM.DISCOVER_STORAGE_TABLE_COLUMN_SEGMENTS') {
    $d = [string]$s.DIMENSION_NAME; $id = [string]$s.TABLE_ID; $size = [long]$s.USED_SIZE
    if (-not $tables.ContainsKey($d)) { continue }
    if ($id -match '^H\$.*\$(.+)$') {
      $k = "$d|" + $colName["$d|$($Matches[1])"]
      if ($columns.ContainsKey($k)) { $columns[$k].hierarchy += $size } else { $tables[$d].other += $size }
    } elseif ($id -match '^[RU]\$') { $tables[$d].other += $size }
    else {
      $k = "$d|" + $colName["$d|$($s.COLUMN_ID)"]
      if ($columns.ContainsKey($k)) { $columns[$k].data += $size } else { $tables[$d].other += $size }
    }
  }
  foreach ($c in $columns.Values) {
    $c.size = $c.dictionary + $c.data + $c.hierarchy
    if ($tables.ContainsKey($c.table)) { $tables[$c.table].size += $c.size }
  }
  foreach ($t in $tables.Values) { $t.size += $t.other }
  $name = ($instances | Where-Object { $_.port -eq $Port }).name
  if ($remote) { $name = $Database }
  Out-Json @{ source = $(if ($remote) { "server: $name" } else { "Power BI Desktop: $name" }); tables = @($tables.Values); columns = @($columns.Values) }
} finally { $conn.Close() }
