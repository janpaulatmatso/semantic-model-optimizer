# Changes measures in a model that is open in Power BI Desktop, without closing it.
# Only measures, and only on this computer (localhost): that is what Power BI Desktop supports from external tools.
#   powershell -File xmla-write.ps1 -InputFile ops.json [-Database name]
# The server comes from the environment variable SMO_XMLA_CONN and must be localhost:port.
# ops.json: [{"op": "edit", "table": "Sales", "name": "Revenue", "expression": "...", "description": "...", "formatString": "...", "displayFolder": "...", "isHidden": false}]
# Uses the Tabular Object Model that ships with DAX Studio and Tabular Editor. Save the file in Power BI Desktop afterwards to keep the change.
param([string]$InputFile = '', [string]$Database = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($o) { $o | ConvertTo-Json -Depth 6 -Compress }
try {
  $server = $env:SMO_XMLA_CONN
  if ($server -notmatch '^(localhost|127\.0\.0\.1):\d+$') { Out-Json @{ error = 'Changing a live model is only possible for a file open in Power BI Desktop on this computer.' }; exit 0 }
  $ops = @((Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ })
  $dirs = @($env:SMO_TOM_DIR, "$env:ProgramFiles\DAX Studio\bin", "$env:ProgramFiles\Tabular Editor 3", "${env:ProgramFiles(x86)}\Tabular Editor") | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'Microsoft.AnalysisServices.Tabular.dll')) }
  if (-not $dirs) { Out-Json @{ error = 'The Tabular Object Model was not found. Install DAX Studio or Tabular Editor.' }; exit 0 }
  foreach ($n in 'Microsoft.AnalysisServices.Core.dll', 'Microsoft.AnalysisServices.Tabular.dll') { $p = Join-Path $dirs[0] $n; if (Test-Path -LiteralPath $p) { Add-Type -Path $p } }
  $srv = New-Object Microsoft.AnalysisServices.Tabular.Server
  $srv.Connect("Data Source=$server")
  try {
    $db = if ($Database) { $srv.Databases.FindByName($Database) } else { $null }
    if (-not $db) { $db = $srv.Databases[0] }
    $done = 0; $missing = @()
    foreach ($o in $ops) {
      $t = $db.Model.Tables.Find([string]$o.table)
      $m = if ($t) { $t.Measures.Find([string]$o.name) } else { $null }
      if (-not $m) { $missing += "$($o.table)[$($o.name)]"; continue }
      if ($o.op -eq 'edit') {
        $names = $o.PSObject.Properties.Name
        if ($names -contains 'expression') { $m.Expression = [string]$o.expression }
        if ($names -contains 'description') { $m.Description = [string]$o.description }
        if ($names -contains 'formatString') { $m.FormatString = [string]$o.formatString }
        if ($names -contains 'displayFolder') { $m.DisplayFolder = [string]$o.displayFolder }
        if ($names -contains 'isHidden') { $m.IsHidden = [bool]$o.isHidden }
        $done++
      }
    }
    if ($done) { $db.Model.SaveChanges() | Out-Null }
    Out-Json @{ changed = $done; missing = @($missing) }
  } finally { $srv.Disconnect() }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $msg + ' ' + $_.Exception.InnerException.Message }
  Out-Json @{ error = 'Changing the open model failed: ' + $msg }
}
