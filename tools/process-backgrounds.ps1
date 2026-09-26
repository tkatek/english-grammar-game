$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$Downloads = "C:\Users\HP\Downloads"
$OutRoot = "C:\Users\HP\Desktop\soufinae\game2\english-grammar-game\assets\images"

function Get-Image($path) {
    $fs = [System.IO.File]::OpenRead($path)
    try { return [System.Drawing.Image]::FromStream($fs) } finally { $fs.Close() }
}

$targets = @(
    @{ src = "Image ChatGPT 26 sept. 2026, 18_44_41-1.png"; out = "game-bg-desktop.jpg" },
    @{ src = "Image ChatGPT 26 sept. 2026, 18_44_42-2.png"; out = "game-bg-tablet.jpg" },
    @{ src = "Image ChatGPT 26 sept. 2026, 18_44_44-3.png"; out = "game-bg-mobile.jpg" }
)

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]84)

foreach ($t in $targets) {
    $img = Get-Image (Join-Path $Downloads $t.src)
    $outPath = Join-Path $OutRoot $t.out
    $img.Save($outPath, $jpegCodec, $encParams)
    Write-Output ("saved {0} from {1} ({2}x{3})" -f $t.out, $t.src, $img.Width, $img.Height)
    $img.Dispose()
}

# ---- Hole detection per background ----
foreach ($t in $targets) {
    $img = Get-Image (Join-Path $OutRoot $t.out)
    $gw = 220; $gh = [int][Math]::Round(220 * $img.Height / $img.Width)
    $bmp = New-Object System.Drawing.Bitmap($gw, $gh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $g.DrawImage($img, 0, 0, $gw, $gh)
    $g.Dispose(); $img.Dispose()

    $grid = New-Object 'bool[,]' $gw, $gh
    for ($y = 0; $y -lt $gh; $y++) {
        for ($x = 0; $x -lt $gw; $x++) {
            $c = $bmp.GetPixel($x, $y)
            $bright = ($c.R + $c.G + $c.B) / 3.0
            $max = [Math]::Max($c.R, [Math]::Max($c.G, $c.B)); $min = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
            # dark hole opening: very dark, low saturation, not strongly blue, below skyline
            if ($bright -lt 64 -and ($max - $min) -lt 58 -and $c.B -le $c.R + 26 -and $y -gt ($gh * 0.32)) { $grid[$x, $y] = $true }
        }
    }
    $bmp.Dispose()

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
                if ($count -gt 30) {
                    [void]$clusters.Add(@{ Count = $count; Cx = ($sx / $count / $gw * 100); Cy = ($sy / $count / $gh * 100); X0 = ($minCx / $gw * 100); X1 = ($maxCx / $gw * 100); Y0 = ($minCy / $gh * 100); Y1 = ($maxCy / $gh * 100) })
                }
            }
        }
    }
    $clusters = $clusters | Sort-Object { $_.Cy } | Select-Object -First 10
    Write-Output ""
    Write-Output ("===== {0} holes (percent, sorted by y) =====" -f $t.out)
    foreach ($c in $clusters) {
        Write-Output ("size={0}px  center=({1:n1}%, {2:n1}%)  bbox=({3:n1}-{4:n1}%, {5:n1}-{6:n1}%)" -f $c.Count, $c.Cx, $c.Cy, $c.X0, $c.X1, $c.Y0, $c.Y1)
    }
}
