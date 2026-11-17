# Leest regels en geheugengebruik uit een geopend Power BI Desktop-bestand (alleen lezen).
#   powershell -File desktop-stats.ps1 -List         -> geopende bestanden met poort
#   powershell -File desktop-stats.ps1 -Port 12345   -> statistieken als JSON
# Heeft ADOMD.NET nodig; dat zit o.a. bij DAX Studio, Tabular Editor en SSMS.
param([switch]$List, [int]$Port = 0)
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
    if (-not $title) { $title = "Power BI Desktop ($($parent.Id))" }
    [pscustomobject]@{ port = [int]$port; name = $title }
  }
}

if ($List) { Out-Json @{ instances = @(Get-Instances) }; exit 0 }

$instances = @(Get-Instances)
if (-not ($instances | Where-Object { $_.port -eq $Port })) {
  Out-Json @{ error = 'Dit is geen poort van een geopend Power BI Desktop-bestand.' }; exit 0
}

$candidates = @($env:SMO_ADOMD) + @(
  "$env:ProgramFiles\DAX Studio\bin\Microsoft.AnalysisServices.AdomdClient.dll",
  "$env:ProgramFiles\Tabular Editor 3\Microsoft.AnalysisServices.AdomdClient.dll",
  "${env:ProgramFiles(x86)}\Tabular Editor\Microsoft.AnalysisServices.AdomdClient.dll"
) + @(Get-ChildItem "$env:windir\Microsoft.NET\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient" -Recurse -Filter *.dll -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | ForEach-Object FullName)
$dll = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $dll) {
  Out-Json @{ error = 'ADOMD.NET niet gevonden. Installeer DAX Studio, of exporteer daar een .vpax (Advanced > Export Metrics) en laad die.' }; exit 0
}
Add-Type -Path $dll

$conn = New-Object Microsoft.AnalysisServices.AdomdClient.AdomdConnection("Data Source=localhost:$Port")
$conn.Open()
function Query($sql) {
  $cmd = $conn.CreateCommand(); $cmd.CommandText = $sql
  $r = $cmd.ExecuteReader(); $rows = @()
  while ($r.Read()) { $o = @{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $o[$r.GetName($i)] = $r.GetValue($i) }; $rows += $o }
  $r.Close(); $rows
}
try {
  $tables = @{}; $columns = @{}
  $colName = @{}   # "tabel|COLUMN_ID" -> kolomnaam
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
  Out-Json @{ source = "Power BI Desktop: $name"; tables = @($tables.Values); columns = @($columns.Values) }
} finally { $conn.Close() }
