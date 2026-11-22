# Runs the Sienna spike script on one case and prints a trimmed view of what it reported.
#   run_sienna.ps1 <name> <raw> <dyr or -> <from_bus> <to_bus> [t_trip] [tf]
param(
    [string]$Name, [string]$Raw, [string]$Dyr, [string]$From, [string]$To,
    [string]$TTrip = "1.0", [string]$Tf = "10.0"
)
$dev = "$env:LOCALAPPDATA\tensa-dev"
$out = "$dev\spike\sienna\$Name"
$err = "$dev\spike\sienna_$Name.err.txt"
$script = Join-Path $PSScriptRoot "sienna_run.jl"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$julia = "$env:LOCALAPPDATA\Microsoft\WindowsApps\julia.exe"
cmd /c "`"$julia`" --project=`"$dev\sienna-env`" `"$script`" `"$Raw`" `"$Dyr`" `"$out`" $From $To $TTrip $Tf 2> `"$err`""
"exit: $LASTEXITCODE"
"--- stderr (trimmed) ---"
Get-Content $err -Encoding UTF8 |
    Where-Object { $_ -notmatch '^\s*(\S\s+)?\[\d+\]|^\s*(\S\s+)?@ |^\S @ |Substation|Storage data' } |
    ForEach-Object { if ($_.Length -gt 220) { $_.Substring(0, 220) } else { $_ } } |
    Select-Object -First 40
"--- files ---"
Get-ChildItem $out -File -ErrorAction SilentlyContinue | ForEach-Object { "{0} {1:N0}" -f $_.Name, $_.Length }
