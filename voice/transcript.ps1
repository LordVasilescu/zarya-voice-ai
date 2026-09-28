# © 2026 Mathew. All rights reserved.
# Live transcript viewer for the Zarya talking terminal.
# Tails the transcript file that the Claude Code hooks append to and prints it
# with color: Grillo in cyan, Zarya in magenta. Run this in a split terminal
# pane in Cursor, right beside Claude Code, for a running live transcript.
#
# Override the file location with $env:CLAUDE_TRANSCRIPT_FILE (must match the
# value the hooks use). Defaults to the temp file the hooks write by default.

$file = $env:CLAUDE_TRANSCRIPT_FILE
if (-not $file) { $file = Join-Path $env:TEMP 'zarya_live_transcript.txt' }

if (-not (Test-Path $file)) {
    New-Item -ItemType File -Path $file -Force | Out-Null
}

$host.UI.RawUI.WindowTitle = 'Zarya — Live Transcript'
Clear-Host
Write-Host '  ZARYA LIVE TRANSCRIPT  ' -ForegroundColor Black -BackgroundColor Magenta
Write-Host "  tailing: $file" -ForegroundColor DarkGray
Write-Host ''

$speakerColor = 'Gray'
Get-Content -Path $file -Wait -Encoding UTF8 | ForEach-Object {
    $line = $_
    if ($line -match '^\[\d\d:\d\d\]\s*GRILLO:') { $speakerColor = 'Cyan' }
    elseif ($line -match '^\[\d\d:\d\d\]\s*ZARYA:') { $speakerColor = 'Magenta' }
    Write-Host $line -ForegroundColor $speakerColor
}
