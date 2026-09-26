param()
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$Downloads = "C:\Users\HP\Downloads"
$OutRoot   = "C:\Users\HP\Desktop\soufinae\game2\english-grammar-game\assets"

function Get-Image($path) {
    $fs = [System.IO.File]::OpenRead($path)
    try { return [System.Drawing.Image]::FromStream($fs) } finally { $fs.Close() }
}

# Materialize an image into an independent 32bpp bitmap
function Convert-Bitmap($img) {
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
    $g.Dispose()
    return $bmp
}

# Downscaled copy for fast pixel work
function Get-Thumb($bmp, $w, $h) {
    $t = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($t)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $g.DrawImage($bmp, 0, 0, $w, $h)
    $g.Dispose()
    return $t
}

# Find bbox of non-transparent content via a small thumbnail (tolerance ~= cell/80)
function Get-ContentBBox($bmp, [int]$thumbW = 80) {
    $ratio = $bmp.Height / $bmp.Width
    $tw = $thumbW
    $th = [int][Math]::Max(4, [Math]::Round($thumbW * $ratio))
    $t = Get-Thumb $bmp $tw $th
    $minX = $tw; $minY = $th; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $th; $y++) {
        for ($x = 0; $x -lt $tw; $x++) {
            if ($t.GetPixel($x, $y).A -gt 12) {
                if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    $t.Dispose()
    if ($maxX -lt 0) { return $null }
    $sx = $bmp.Width / $tw; $sy = $bmp.Height / $th
    return @{
        X = [Math]::Max(0, [int]($minX * $sx)); Y = [Math]::Max(0, [int]($minY * $sy))
        W = [Math]::Min($bmp.Width - 1, [int](($maxX + 1) * $sx)) - [Math]::Max(0, [int]($minX * $sx))
        H = [Math]::Min($bmp.Height - 1, [int](($maxY + 1) * $sy)) - [Math]::Max(0, [int]($minY * $sy))
    }
}

function Save-Cell($bmp, $x, $y, $w, $h, $outPath, [int]$pad = 8) {
    $cell = $bmp.Clone((New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bbox = Get-ContentBBox $cell
    if ($null -eq $bbox) { $cell.Dispose(); return $null }
    $cx = [Math]::Max(0, $bbox.X - $pad); $cy = [Math]::Max(0, $bbox.Y - $pad)
    $cw = [Math]::Min($cell.Width - $cx, $bbox.W + 2 * $pad)
    $chh = [Math]::Min($cell.Height - $cy, $bbox.H + 2 * $pad)
    $final = $cell.Clone((New-Object System.Drawing.Rectangle($cx, $cy, $cw, $chh)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $cell.Dispose()
    $final.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $size = "$($final.Width)x$($final.Height)"
    $final.Dispose()
    return $size
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

function Preview-Ascii($path, [int]$w = 20) {
    $img = Get-Image $path
    $h = [int][Math]::Max(4, [Math]::Round($w * $img.Height / $img.Width / 2.0))
    $t = Get-Thumb (Convert-Bitmap $img) $w $h
    for ($y = 0; $y -lt $h; $y++) {
        $line = New-Object System.Text.StringBuilder
        for ($x = 0; $x -lt $w; $x++) { [void]$line.Append((Classify $t.GetPixel($x, $y))) }
        Write-Output ("    " + $line.ToString())
    }
    $t.Dispose(); $img.Dispose()
}

# ---------- 1. Backgrounds -> JPEG ----------
$bgGame = Get-Image (Join-Path $Downloads "Image ChatGPT 26 sept. 2026, 16_20_44-1.png")
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
$bgGame.Save((Join-Path $OutRoot "images\bg-gameplay.jpg"), $jpegCodec, $encParams)
$bgGame.Dispose()
$bgMap = Get-Image (Join-Path $Downloads "Image ChatGPT 26 sept. 2026, 16_20_45-2.png")
$bgMap.Save((Join-Path $OutRoot "images\bg-map.jpg"), $jpegCodec, $encParams)
$bgMap.Dispose()
Write-Output "backgrounds saved as JPEG"

# ---------- 2. Mascot sheet 2x2 ----------
$mascots = [ordered]@{ "owl" = 0; "fox" = 1; "dragon" = 2; "book" = 3 }
$bmp = Convert-Bitmap (Get-Image (Join-Path $Downloads "Image ChatGPT 26 sept. 2026, 16_20_46-3.png"))
New-Item -ItemType Directory -Force -Path (Join-Path $OutRoot "images\mascots") | Out-Null
$half = [int][math]::Floor($bmp.Width / 2); $halfH = [int][math]::Floor($bmp.Height / 2)
foreach ($name in $mascots.Keys) {
    $idx = $mascots[$name]
    $size = Save-Cell $bmp (($idx % 2) * $half) ([int][math]::Floor($idx / 2) * $halfH) $half $halfH (Join-Path $OutRoot "images\mascots\$name.png")
    Write-Output ("mascot {0}: {1}" -f $name, $size)
}
$bmp.Dispose()

# ---------- 3. Icon sheet 5 rows x 4 cols ----------
$bmp = Convert-Bitmap (Get-Image (Join-Path $Downloads "Image ChatGPT 26 sept. 2026, 16_20_47-4.png"))
New-Item -ItemType Directory -Force -Path (Join-Path $OutRoot "icons") | Out-Null
$cols = 4; $rows = 5
$cw = [int][math]::Floor($bmp.Width / $cols); $ch = [int][math]::Floor($bmp.Height / $rows)
$n = 0
for ($r = 0; $r -lt $rows; $r++) {
    for ($c = 0; $c -lt $cols; $c++) {
        $n++
        $cellW = if ($c -eq $cols - 1) { $bmp.Width - $c * $cw } else { $cw }
        $cellH = if ($r -eq $rows - 1) { $bmp.Height - $r * $ch } else { $ch }
        $size = Save-Cell $bmp ($c * $cw) ($r * $ch) $cellW $cellH (Join-Path $OutRoot ("icons\raw{0:d2}.png" -f $n))
        Write-Output ("icon r{0}c{1} -> raw{2:d2}.png {3}" -f ($r + 1), ($c + 1), $n, $size)
    }
}
$bmp.Dispose()

# ---------- 4. Reward sheet 3 cols x 4 rows ----------
$bmp = Convert-Bitmap (Get-Image (Join-Path $Downloads "Image ChatGPT 26 sept. 2026, 16_20_48-6.png"))
New-Item -ItemType Directory -Force -Path (Join-Path $OutRoot "images\rewards") | Out-Null
$cols = 3; $rows = 4
$cw = [int][math]::Floor($bmp.Width / $cols); $ch = [int][math]::Floor($bmp.Height / $rows)
$n = 0
for ($r = 0; $r -lt $rows; $r++) {
    for ($c = 0; $c -lt $cols; $c++) {
        $n++
        $cellW = if ($c -eq $cols - 1) { $bmp.Width - $c * $cw } else { $cw }
        $cellH = if ($r -eq $rows - 1) { $bmp.Height - $r * $ch } else { $ch }
        $size = Save-Cell $bmp ($c * $cw) ($r * $ch) $cellW $cellH (Join-Path $OutRoot ("images\rewards\raw{0:d2}.png" -f $n))
        Write-Output ("reward r{0}c{1} -> raw{2:d2}.png {3}" -f ($r + 1), ($c + 1), $n, $size)
    }
}
$bmp.Dispose()

Write-Output ""
Write-Output "===== ICON SHAPE PREVIEWS ====="
for ($i = 1; $i -le 20; $i++) {
    Write-Output ("--- raw{0:d2} ---" -f $i)
    Preview-Ascii (Join-Path $OutRoot ("icons\raw{0:d2}.png" -f $i)) 20
}
Write-Output ""
Write-Output "===== REWARD SHAPE PREVIEWS ====="
for ($i = 1; $i -le 12; $i++) {
    Write-Output ("--- reward raw{0:d2} ---" -f $i)
    Preview-Ascii (Join-Path $OutRoot ("images\rewards\raw{0:d2}.png" -f $i)) 20
}

# ---------- 5. Hole detection on gameplay background ----------
$bg = Convert-Bitmap (Get-Image (Join-Path $OutRoot "images\bg-gameplay.jpg"))
$gw = 210; $gh = [int][Math]::Round(210 * $bg.Height / $bg.Width)
$t = Get-Thumb $bg $gw $gh
$grid = New-Object 'bool[,]' $gw, $gh
for ($y = 0; $y -lt $gh; $y++) {
    for ($x = 0; $x -lt $gw; $x++) {
        $c = $t.GetPixel($x, $y)
        $bright = ($c.R + $c.G + $c.B) / 3.0
        $max = [Math]::Max($c.R, [Math]::Max($c.G, $c.B)); $min = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
        # dark hole: very dark, low saturation, not strongly blue, below the skyline
        if ($bright -lt 62 -and ($max - $min) -lt 55 -and $c.B -le $c.R + 25 -and $y -gt ($gh * 0.3)) { $grid[$x, $y] = $true }
    }
}
$t.Dispose(); $bg.Dispose()
$visited = New-Object 'bool[,]' $gw, $gh
$clusters = New-Object System.Collections.ArrayList
for ($y = 0; $y -lt $gh; $y++) {
    for ($x = 0; $x -lt $gw; $x++) {
        if ($grid[$x, $y] -and -not $visited[$x, $y]) {
            $stack = New-Object System.Collections.Stack
            $stack.Push(@($x, $y)); $visited[$x, $y] = $true
            $count = 0; $sx = 0.0; $sy = 0.0; $minCx = $x; $maxCx = $x; $minCy = $y; $maxCy = $y
            while ($stack.Count -gt 0) {
                $pt = $stack.Pop(); $px = $pt[0]; $py = $pt[1]
                $count++; $sx += $px; $sy += $py
                if ($px -lt $minCx) { $minCx = $px }; if ($px -gt $maxCx) { $maxCx = $px }
                if ($py -lt $minCy) { $minCy = $py }; if ($py -gt $maxCy) { $maxCy = $py }
                foreach ($d in @(@(1, 0), @(-1, 0), @(0, 1), @(0, -1))) {
                    $nx = $px + $d[0]; $ny = $py + $d[1]
                    if ($nx -ge 0 -and $nx -lt $gw -and $ny -ge 0 -and $ny -lt $gh -and $grid[$nx, $ny] -and -not $visited[$nx, $ny]) {
                        $visited[$nx, $ny] = $true; $stack.Push(@($nx, $ny))
                    }
                }
            }
            if ($count -gt 25) {
                [void]$clusters.Add(@{ Count = $count; Cx = ($sx / $count / $gw * 100); Cy = ($sy / $count / $gh * 100); X0 = ($minCx / $gw * 100); X1 = ($maxCx / $gw * 100); Y0 = ($minCy / $gh * 100); Y1 = ($maxCy / $gh * 100) })
            }
        }
    }
}
$clusters = $clusters | Sort-Object { $_.Count } -Descending | Select-Object -First 12
Write-Output ""
Write-Output "===== DARK CLUSTERS IN GAMEPLAY BG (percent coords) ====="
foreach ($c in $clusters) {
    Write-Output ("size={0}px  center=({1:n1}%, {2:n1}%)  bbox=({3:n1}-{4:n1}%, {5:n1}-{6:n1}%)" -f $c.Count, $c.Cx, $c.Cy, $c.X0, $c.X1, $c.Y0, $c.Y1)
}
