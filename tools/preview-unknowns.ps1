$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$OutRoot = "C:\Users\HP\Desktop\soufinae\game2\english-grammar-game\assets"

function Get-Image($path) {
    $fs = [System.IO.File]::OpenRead($path)
    try { return [System.Drawing.Image]::FromStream($fs) } finally { $fs.Close() }
}
function Convert-Bitmap($img) {
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
    $g.Dispose()
    return $bmp
}
function Classify($c) {
    if ($c.A -lt 100) { return '.' }
    $r = $c.R; $g = $c.G; $b = $c.B
    $bright = ($r + $g + $b) / 3.0
    $max = [Math]::Max($r, [Math]::Max($g, $b)); $min = [Math]::Min($r, [Math]::Min($g, $b)); $sat = $max - $min
    if ($bright -lt 42 -and $sat -lt 40) { return 'K' }
    if ($bright -lt 115 -and $sat -lt 34) { return 'g' }
    if ($bright -ge 215 -and $sat -lt 30) { return 'W' }
    if ($sat -lt 30) { return 'w' }
    if ($b -gt $r + 20 -and $b -gt $g + 10) { if ($r -gt $g + 12) { return 'P' }; if ($r -ge 120) { return 'p' }; return 'B' }
    if ($r -gt $g + 25 -and $g -gt $b + 15) { return 'O' }
    if ($r -gt $g + 40 -and $r -gt $b + 40) { if ($bright -gt 190) { return 'M' }; return 'R' }
    if ($r -gt $b + 40 -and $g -gt $b + 40) { return 'Y' }
    if ($g -gt $r + 15 -and $g -gt $b + 5) { return 'G' }
    return '?'
}
foreach ($n in @(6, 9, 10, 12, 13, 14, 16, 17, 18)) {
    $img = Get-Image (Join-Path $OutRoot ("icons\raw{0:d2}.png" -f $n))
    $w = 32
    $h = [int][Math]::Max(6, [Math]::Round($w * $img.Height / $img.Width / 2.0))
    $t = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($t)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $g.DrawImage((Convert-Bitmap $img), 0, 0, $w, $h)
    $g.Dispose()
    Write-Output ("--- raw{0:d2} ---" -f $n)
    for ($y = 0; $y -lt $h; $y++) {
        $line = New-Object System.Text.StringBuilder
        for ($x = 0; $x -lt $w; $x++) { [void]$line.Append((Classify $t.GetPixel($x, $y))) }
        Write-Output ("   " + $line.ToString())
    }
    $t.Dispose(); $img.Dispose()
}
