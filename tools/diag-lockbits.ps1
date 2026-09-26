$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$p = "C:\Users\HP\Downloads\Image ChatGPT 26 sept. 2026, 16_20_47-4.png"
$fs = [System.IO.File]::OpenRead($p)
$sheet = [System.Drawing.Image]::FromStream($fs)
$fs.Close()
Write-Output ("sheet: {0}x{1} {2} {3}dpi" -f $sheet.Width, $sheet.Height, $sheet.PixelFormat, $sheet.HorizontalResolution)
$bmp = New-Object System.Drawing.Bitmap($sheet.Width, $sheet.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($sheet, 0, 0, $sheet.Width, $sheet.Height)
$g.Dispose(); $sheet.Dispose()
Write-Output ("bmp: {0}x{1} {2}" -f $bmp.Width, $bmp.Height, $bmp.PixelFormat)

$tests = @(
    @(0, 0, 627, 627),
    @(627, 0, 627, 627),
    @(0, 627, 627, 627),
    @(627, 627, 627, 627),
    @(0, 0, 1254, 1254)
)
foreach ($t in $tests) {
    $rect = New-Object System.Drawing.Rectangle($t[0], $t[1], $t[2], $t[3])
    try {
        $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $len = $data.Stride * $t[3]
        Write-Output ("rect({0}) stride={1} len={2}" -f ($t -join ","), $data.Stride, $len)
        $buf = New-Object byte[] $len
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $len)
        $nonZero = 0
        for ($i = 3; $i -lt $len; $i += 400) { if ($buf[$i] -gt 10) { $nonZero++ } }
        $bmp.UnlockBits($data)
        Write-Output ("  copied ok, alpha-sampled-nonzero={0}" -f $nonZero)
    } catch {
        Write-Output ("rect({0}) FAILED: {1}" -f ($t -join ","), $_.Exception.Message)
    }
}
