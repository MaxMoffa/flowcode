# Flowcode crash report collector (Windows, PowerShell 5.1+).
#
# Gathers everything needed to diagnose Flowcode crashes on a machine and
# writes it to one Markdown file on the Desktop. Read-only: changes nothing.
#
# Run:  powershell -ExecutionPolicy Bypass -File .\collect-crash-report.ps1
# Optional: -Days 14 (how far back to look), -OutDir <folder>

param(
    [int]$Days = 14,
    [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Continue'
$since = (Get-Date).AddDays(-$Days)
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $OutDir "flowcode-crash-report-$env:COMPUTERNAME-$stamp.md"
$sb = New-Object System.Text.StringBuilder

function Add([string]$text = '') { [void]$sb.AppendLine($text) }
function Section([string]$title) { Add; Add "## $title"; Add }
function Code([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { Add '_(nothing)_'; return }
    Add '```'; Add $text.TrimEnd(); Add '```'
}
function Try-Run([scriptblock]$block) {
    try { & $block } catch { Add "_error: $($_.Exception.Message)_" }
}
# Matches the app and the processes it spawns (agents, webview).
$appPattern = 'flowcode|whisper|ggml'

Add "# Flowcode crash report - $env:COMPUTERNAME"
Add
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  |  Window: last $Days days (since $($since.ToString('yyyy-MM-dd')))  |  Admin: $isAdmin"

# --- System -----------------------------------------------------------------
Section 'System'
Try-Run {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    Add "- **CPU:** $($cpu.Name.Trim()) ($($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads)"
    Add "- **Model:** $($cs.Manufacturer) $($cs.Model)"
    Add "- **OS:** $($os.Caption) $($os.Version) build $($os.BuildNumber)"
    Add "- **RAM:** $([math]::Round($cs.TotalPhysicalMemory / 1GB, 1)) GB physical"
    Add "- **Commit limit:** $([math]::Round($os.TotalVirtualMemorySize / 1MB, 1)) GB, free now $([math]::Round($os.FreeVirtualMemory / 1MB, 1)) GB"
    Add "- **Uptime since:** $($os.LastBootUpTime)"
}
Try-Run {
    Add-Type -Namespace Fc -Name Cpu -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);
'@ -ErrorAction SilentlyContinue
    # PF_AVX2 = 40, PF_AVX512F = 41
    Add "- **AVX2:** $([Fc.Cpu]::IsProcessorFeaturePresent(40))"
    Add "- **AVX-512F:** $([Fc.Cpu]::IsProcessorFeaturePresent(41))"
}
Try-Run {
    $gpus = Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) (driver $($_.DriverVersion))" }
    Add "- **GPU:** $($gpus -join '; ')"
}
Try-Run {
    $pf = Get-CimInstance Win32_PageFileUsage | ForEach-Object { "$($_.Name) alloc $($_.AllocatedBaseSize) MB, peak $($_.PeakUsage) MB" }
    Add "- **Pagefile:** $(if ($pf) { $pf -join '; ' } else { 'none' })"
}

# --- Flowcode install ---------------------------------------------------------
Section 'Flowcode install'
Try-Run {
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    $apps = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'flowcode' }
    if ($apps) {
        foreach ($a in $apps) { Add "- $($a.DisplayName) **$($a.DisplayVersion)** - $($a.InstallLocation) (installed $($a.InstallDate))" }
    } else { Add '_No uninstall entry found._' }
}
Try-Run {
    $exe = Get-Process flowcode -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
        Add "- Running now: PID $($exe.Id), started $($exe.StartTime), $($exe.Path)"
        Add "- File version: $($exe.MainModule.FileVersionInfo.FileVersion)"
    } else { Add '- Not running now.' }
}
Try-Run {
    $vulkan = Test-Path "$env:WINDIR\System32\vulkan-1.dll"
    Add "- vulkan-1.dll present: $vulkan"
}

# --- Crash events -------------------------------------------------------------
Section 'Application crash events (1000 Application Error, 1001 WER, 1026 .NET)'
Try-Run {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001, 1026; StartTime = $since } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match $appPattern }
    if (-not $ev) { Add '_None._' }
    foreach ($e in $ev) {
        Add "### $($e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) - id $($e.Id) $($e.ProviderName)"
        Code $e.Message
    }
}

Section 'Hangs (1002 Application Hang)'
Try-Run {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1002; StartTime = $since } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match $appPattern }
    if (-not $ev) { Add '_None._' }
    foreach ($e in $ev) {
        Add "### $($e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'))"
        Code $e.Message
    }
}

# --- Memory exhaustion --------------------------------------------------------
Section 'Low memory events (Resource-Exhaustion-Detector, top consumers)'
Try-Run {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Resource-Exhaustion-Detector'; StartTime = $since } -ErrorAction SilentlyContinue
    if (-not $ev) { Add '_None._' }
    foreach ($e in $ev) {
        Add "### $($e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) - id $($e.Id)"
        Code $e.Message
        # The message only names the top 3; the event data has commit sizes too.
        Try-Run {
            $x = [xml]$e.ToXml()
            $pairs = $x.Event.UserData.FirstChild.ChildNodes | ForEach-Object { "$($_.Name) = $($_.InnerText)" }
            Code ($pairs -join "`n")
        }
    }
}

Section 'Unexpected shutdowns / bugchecks (System 41, 6008, 1001)'
Try-Run {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 6008, 1001; StartTime = $since } -ErrorAction SilentlyContinue
    if (-not $ev) { Add '_None._' }
    foreach ($e in $ev) {
        $msg = ($e.Message -split "`n" | Select-Object -First 4) -join "`n"
        Add "- $($e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')) id $($e.Id) $($e.ProviderName): $($msg -replace "`r?`n", ' ')"
    }
}

# --- WER reports --------------------------------------------------------------
Section 'Windows Error Reporting reports'
Try-Run {
    $roots = "$env:ProgramData\Microsoft\Windows\WER\ReportArchive",
             "$env:ProgramData\Microsoft\Windows\WER\ReportQueue",
             "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive",
             "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportQueue"
    $dirs = foreach ($r in $roots) {
        if (Test-Path $r) { Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $appPattern -and $_.LastWriteTime -ge $since } }
    }
    if (-not $dirs) { Add '_None._' }
    $keep = '^(EventType|EventTime|Sig\[\d+\]\.(Name|Value)|DynamicSig\[\d+\]\.(Name|Value)|AppPath|FriendlyEventName|ConsentKey|AppName|TargetAppVer|ReportStatus)='
    foreach ($d in $dirs | Sort-Object LastWriteTime) {
        Add "### $($d.Name) ($($d.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))"
        $wer = Join-Path $d.FullName 'Report.wer'
        $lines = Get-Content $wer -Encoding Unicode -ErrorAction SilentlyContinue
        if ($lines) { Code (($lines | Where-Object { $_ -match $keep }) -join "`n") }
        else { Add '_Report.wer not readable (run as administrator for details)._' }
        $files = Get-ChildItem $d.FullName -File -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length / 1KB)) KB)" }
        Add "Files: $($files -join ', ')"
        Add
    }
}

Section 'Crash dumps'
Try-Run {
    $dumps = Get-ChildItem "$env:LOCALAPPDATA\CrashDumps" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $appPattern }
    if (-not $dumps) { Add '_None in %LOCALAPPDATA%\CrashDumps._' }
    foreach ($f in $dumps) { Add "- $($f.FullName) - $([math]::Round($f.Length / 1MB, 1)) MB - $($f.LastWriteTime)" }
}

# --- Memory right now ---------------------------------------------------------
Section 'Top 15 processes by commit (now)'
Try-Run {
    $rows = Get-Process | Sort-Object PagedMemorySize64 -Descending | Select-Object -First 15 |
        ForEach-Object { '{0,-32} {1,7} {2,9:N2} GB {3,9:N2} GB' -f $_.ProcessName, $_.Id, ($_.PagedMemorySize64 / 1GB), ($_.WorkingSet64 / 1GB) }
    Code (("{0,-32} {1,7} {2,12} {3,12}" -f 'Process', 'PID', 'Commit', 'WorkingSet') + "`n" + ($rows -join "`n"))
}
Section 'Flowcode process tree (now)'
Try-Run {
    $all = Get-CimInstance Win32_Process
    $root = $all | Where-Object { $_.Name -eq 'flowcode.exe' }
    if (-not $root) { Add '_Flowcode not running._'; return }
    $ids = @($root.ProcessId)
    $changed = $true
    while ($changed) {
        $kids = $all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId }
        $changed = [bool]$kids
        $ids += $kids.ProcessId
    }
    $rows = $all | Where-Object { $ids -contains $_.ProcessId } |
        ForEach-Object { '{0,-28} {1,7} {2,7} {3,9:N2} GB' -f $_.Name, $_.ProcessId, $_.ParentProcessId, ($_.PageFileUsage / 1MB) }
    Code (("{0,-28} {1,7} {2,7} {3,12}" -f 'Process', 'PID', 'Parent', 'Commit') + "`n" + ($rows -join "`n"))
    $sum = ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object PageFileUsage -Sum).Sum / 1MB
    Add "Total commit of Flowcode tree: **$([math]::Round($sum, 2)) GB**"
}

# --- App logs -----------------------------------------------------------------
Section 'Flowcode log files (last 80 lines each)'
Try-Run {
    # Top level only: subfolders hold agent sandboxes and WebView storage
    # (private data, not useful here).
    $logs = Get-ChildItem "$env:APPDATA\com.maxmoffa.flowcode\*" -File -Include *.log, *.log.old -ErrorAction SilentlyContinue
    if (-not $logs) { Add '_No log files found._' }
    foreach ($l in $logs) {
        Add "### $($l.FullName) ($($l.LastWriteTime))"
        Code ((Get-Content $l.FullName -Tail 80 -ErrorAction SilentlyContinue) -join "`n")
    }
}

# --- Earlier diagnosis -----------------------------------------------------------
Section 'Earlier Codex diagnosis (if present)'
Try-Run {
    $diag = Get-ChildItem 'C:\Work\_tasks\flowcode-crash-analysis' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.txt', '.md' }
    if (-not $diag) { Add '_Not found._' }
    foreach ($f in $diag) {
        Add "### $($f.Name)"
        Code ((Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue))
    }
}

[System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Report written to: $out"
