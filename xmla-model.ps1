# Reads the definition of a semantic model over XMLA (read-only) and prints it as JSON in model.bim shape.
# Works with Azure Analysis Services (asazure://…), a Power BI workspace (powerbi://…), SQL Server
# Analysis Services, and a file that is open in Power BI Desktop (localhost:port).
#   powershell -File xmla-model.ps1 -Server "asazure://westeurope.asazure.windows.net/myserver"            -> databases
#   powershell -File xmla-model.ps1 -Server "…" -Database "Sales"                                          -> the model
# The connection string can also be passed in the environment variable SMO_XMLA_CONN.
# Needs ADOMD.NET, which ships with DAX Studio, Tabular Editor and SSMS. Sign-in is interactive.
param([string]$Server = '', [string]$Database = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($o) { $o | ConvertTo-Json -Depth 12 -Compress }

try {
  $conn = $env:SMO_XMLA_CONN
  if (-not $conn) { $conn = $Server }
  if (-not $conn) { Out-Json @{ error = 'No server given.' }; exit 0 }
  if ($conn -notmatch '=') { $conn = "Data Source=$conn" }
  if ($Database -and $conn -notmatch '(?i)initial catalog\s*=') { $conn = "$conn;Initial Catalog=$Database" }

  $candidates = @($env:SMO_ADOMD) + @(
    "$env:ProgramFiles\DAX Studio\bin\Microsoft.AnalysisServices.AdomdClient.dll",
    "$env:ProgramFiles\Tabular Editor 3\Microsoft.AnalysisServices.AdomdClient.dll",
    "${env:ProgramFiles(x86)}\Tabular Editor\Microsoft.AnalysisServices.AdomdClient.dll"
  ) + @(Get-ChildItem "$env:windir\Microsoft.NET\assembly\GAC_MSIL\Microsoft.AnalysisServices.AdomdClient" -Recurse -Filter *.dll -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | ForEach-Object FullName)
  $dll = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $dll) { Out-Json @{ error = 'ADOMD.NET not found. Install DAX Studio (it ships with it), or set SMO_ADOMD to the path of Microsoft.AnalysisServices.AdomdClient.dll.' }; exit 0 }
  Add-Type -Path $dll

  $c = New-Object Microsoft.AnalysisServices.AdomdClient.AdomdConnection($conn)
  $c.Open()
  function Query($sql) {
    $cmd = $c.CreateCommand(); $cmd.CommandText = $sql
    $r = $cmd.ExecuteReader(); $rows = New-Object System.Collections.ArrayList
    while ($r.Read()) { $o = @{}; for ($i = 0; $i -lt $r.FieldCount; $i++) { $v = $r.GetValue($i); if ($v -is [DBNull]) { $v = $null }; $o[$r.GetName($i)] = $v }; [void]$rows.Add($o) }
    $r.Close(); , $rows
  }
  function TryQuery($sql) { try { Query $sql } catch { , @() } }

  try {
    if (-not $Database -and $conn -notmatch '(?i)initial catalog\s*=') {
      $cats = Query 'SELECT [CATALOG_NAME] FROM $SYSTEM.DBSCHEMA_CATALOGS'
      Out-Json @{ catalogs = @($cats | ForEach-Object { [string]$_.CATALOG_NAME } | Sort-Object) }
      exit 0
    }

    $dataTypes = @{ 2 = 'string'; 6 = 'int64'; 8 = 'double'; 9 = 'dateTime'; 10 = 'decimal'; 11 = 'boolean'; 17 = 'binary'; 20 = 'variant' }
    $partTypes = @{ 1 = 'query'; 2 = 'calculated'; 4 = 'm'; 5 = 'entity'; 6 = 'policyRange'; 7 = 'calculationGroup' }
    $modes = @{ 0 = 'import'; 1 = 'directQuery'; 2 = 'default'; 3 = 'push'; 4 = 'dual'; 5 = 'directLake' }

    try { $tRows = Query 'SELECT * FROM $SYSTEM.TMSCHEMA_TABLES' }
    catch { Out-Json @{ error = 'Could not read the model definition. Reading it over XMLA needs admin or write permission on the model (a viewer cannot query the schema). Server said: ' + $_.Exception.Message }; exit 0 }

    $tables = [ordered]@{}; $colName = @{}; $tableOfCol = @{}
    foreach ($t in $tRows) {
      $tables[[string]$t.ID] = [ordered]@{ name = [string]$t.Name; description = [string]$t.Description; isHidden = [bool]$t.IsHidden; dataCategory = [string]$t.DataCategory; columns = @(); measures = @(); partitions = @(); hierarchies = @() }
    }
    foreach ($col in (Query 'SELECT * FROM $SYSTEM.TMSCHEMA_COLUMNS')) {
      $t = $tables[[string]$col.TableID]; if (-not $t) { continue }
      $name = [string]$col.ExplicitName; if (-not $name) { $name = [string]$col.InferredName }
      $colName[[string]$col.ID] = $name; $tableOfCol[[string]$col.ID] = $t.name
      $type = switch ([int]$col.Type) { 2 { 'calculated' } 3 { 'rowNumber' } 4 { 'calculatedTableColumn' } default { 'data' } }
      $dt = $dataTypes[[int]$col.ExplicitDataType]; if (-not $dt) { $dt = $dataTypes[[int]$col.InferredDataType] }
      $t.columns += [ordered]@{ name = $name; type = $type; dataType = $dt; isHidden = [bool]$col.IsHidden; description = [string]$col.Description
        expression = [string]$col.Expression; sourceColumn = [string]$col.SourceColumn; isNullable = [bool]$col.IsNullable; displayFolder = [string]$col.DisplayFolder; sortById = [string]$col.SortByColumnID }
    }
    foreach ($t in $tables.Values) { foreach ($col in $t.columns) { if ($col.sortById -and $colName[$col.sortById]) { $col.sortByColumn = $colName[$col.sortById] }; $col.Remove('sortById') } }
    foreach ($m in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_MEASURES')) {
      $t = $tables[[string]$m.TableID]; if (-not $t) { continue }
      $t.measures += [ordered]@{ name = [string]$m.Name; expression = [string]$m.Expression; description = [string]$m.Description; isHidden = [bool]$m.IsHidden
        formatString = [string]$m.FormatString; displayFolder = [string]$m.DisplayFolder }
    }
    foreach ($p in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_PARTITIONS')) {
      $t = $tables[[string]$p.TableID]; if (-not $t) { continue }
      $pt = $partTypes[[int]$p.Type]; if (-not $pt) { $pt = 'none' }
      $t.partitions += [ordered]@{ name = [string]$p.Name; mode = $modes[[int]$p.Mode]; source = [ordered]@{ type = $pt; expression = [string]$p.QueryDefinition } }
    }
    $hier = @{}
    foreach ($h in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_HIERARCHIES')) {
      $t = $tables[[string]$h.TableID]; if (-not $t) { continue }
      $o = [ordered]@{ name = [string]$h.Name; levels = @() }; $hier[[string]$h.ID] = $o; $t.hierarchies += $o
    }
    foreach ($l in ((TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_LEVELS') | Sort-Object { [int]$_.Ordinal })) {
      $h = $hier[[string]$l.HierarchyID]; if ($h) { $h.levels += [ordered]@{ name = [string]$l.Name; column = $colName[[string]$l.ColumnID] } }
    }
    $cg = @{}
    foreach ($g in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_CALCULATION_GROUPS')) {
      $t = $tables[[string]$g.TableID]; if ($t) { $t.calculationGroup = [ordered]@{ calculationItems = @() }; $cg[[string]$g.ID] = $t.calculationGroup }
    }
    foreach ($i in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_CALCULATION_ITEMS')) {
      $g = $cg[[string]$i.CalculationGroupID]; if ($g) { $g.calculationItems += [ordered]@{ name = [string]$i.Name; expression = [string]$i.Expression } }
    }
    $rels = @()
    foreach ($r in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_RELATIONSHIPS')) {
      $ft = $tables[[string]$r.FromTableID]; $tt = $tables[[string]$r.ToTableID]; if (-not $ft -or -not $tt) { continue }
      $rels += [ordered]@{ name = [string]$r.Name; fromTable = $ft.name; fromColumn = $colName[[string]$r.FromColumnID]; toTable = $tt.name; toColumn = $colName[[string]$r.ToColumnID]
        isActive = [bool]$r.IsActive; relyOnReferentialIntegrity = [bool]$r.RelyOnReferentialIntegrity; fromCardinality = $(if ([int]$r.FromCardinality -eq 1) { 'one' } else { 'many' }); toCardinality = $(if ([int]$r.ToCardinality -eq 2) { 'many' } else { 'one' })
        crossFilteringBehavior = $(if ([int]$r.CrossFilteringBehavior -eq 2) { 'bothDirections' } else { 'oneDirection' }) }
    }
    $roles = [ordered]@{}
    foreach ($r in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_ROLES')) { $roles[[string]$r.ID] = [ordered]@{ name = [string]$r.Name; tablePermissions = @() } }
    foreach ($p in (TryQuery 'SELECT * FROM $SYSTEM.TMSCHEMA_TABLE_PERMISSIONS')) {
      $role = $roles[[string]$p.RoleID]; $t = $tables[[string]$p.TableID]
      if ($role -and $t) { $role.tablePermissions += [ordered]@{ name = $t.name; filterExpression = [string]$p.FilterExpression } }
    }
    Out-Json @{ model = [ordered]@{ tables = @($tables.Values); relationships = @($rels); roles = @($roles.Values) } }
  } finally { $c.Close() }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $msg + ' ' + $_.Exception.InnerException.Message }
  Out-Json @{ error = 'Connecting failed: ' + $msg }
}
