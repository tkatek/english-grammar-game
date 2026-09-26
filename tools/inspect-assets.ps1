param(
    [int]$MapWidth = 76,
    [switch]$AsciiMap
)
Add-Type -AssemblyName System.Drawing

$Downloads = "C:\Users\HP\Downloads"
$Paths = Get-ChildItem -LiteralPath $Downloads -Filter "Image ChatGPT 26 sept. 2026*.png" |
    Sort-Object Name | ForEach-Object { $_.FullName }

function Get-Image($path) {
    $fs = [System.IO.File]::OpenRead($path)
    try { [System.Drawing.Image]::FromStream($fs) } finally { $fs.Close() }
}

function Classify([byte]$r, [byte]$g, [byte]$b, [byte]$a) {
    if ($a -lt 100) { return '.' }
    $bright = ($r + $g + $b) / 3.0
    $max = [Math]::Max($r, [Math]::Max($g, $b))
    $min = [Math]::Min($r, [Math]::Min($g, $b))
    $sat = $max - $min
    if ($bright -lt 42 -and $sat -lt 40) { return 'K' }   # near black
    if ($bright -lt 115 -and $sat -lt 34) { return 'g' }  # gray
    if ($bright -ge 215 -and $sat -lt 30) { return 'W' }  # white
    if ($sat -lt 30) { return 'w' }                       # light gray
    if ($b -gt $r + 20 -and $b -gt $g + 10) {
        if ($r -gt $g + 12) { return 'P' }                # purple
        if ($r -ge 120) { return 'p' }                    # light purple/lavender
        return 'B'                                        # blue
    }
    if ($r -gt $g + 25 -and $g -gt $b + 15) { return 'O' } # orange/brown
    if ($r -gt $g + 40 -and $r -gt $b + 40) {
        if ($bright -gt 190) { return 'M' }               # pink/magenta
        return 'R'                                        # red
    }
    if ($r -gt $b + 40 -and $g -gt $b + 40) { return 'Y' } # yellow
    if ($g -gt $r + 15 -and $g -gt $b + 5) { return 'G' }  # green
    if ($g -gt 150 -and $b -gt 120 -and $r -lt $g) { return 'C' } # cyan
    return '?'
}

foreach ($path in $Paths) {
    $img = Get-Image $path
    $name = [System.IO.Path]::GetFileName($path)
    Write-Output ("FILE: {0}  =>  {1} x {2} px, format {3}" -f $name, $img.Width, $img.Height, $img.PixelFormat)

    if ($AsciiMap) {
        $aspect = $img.Height / $img.Width
        $mw = $MapWidth
        $mh = [int][Math]::Max(6, [Math]::Round($mw * $aspect / 2.0)) # /2: chars are taller than wide
        $bmp = New-Object System.Drawing.Bitmap($mw, $mh)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $g.DrawImage($img, 0, 0, $mw, $mh)
        $g.Dispose()
        $rect = New-Object System.Drawing.Rectangle(0, 0, $mw, $mh)
        $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $stride = $data.Stride
        $bytes = New-Object byte[] ($stride * $mh)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $bmp.UnlockBits($data)
        for ($y = 0; $y -lt $mh; $y++) {
            $line = New-Object System.Text.StringBuilder
            for ($x = 0; $x -lt $mw; $x++) {
                $i = $y * $stride + $x * 4
                [void]$line.Append((Classify $bytes[$i + 2] $bytes[$i + 1] $bytes[$i] $bytes[$i + 3]))
            }
            Write-Output ("{0,3}| {1}" -f $y, $line.ToString())
        }
        $bmp.Dispose()
    }
    $img.Dispose()
}
