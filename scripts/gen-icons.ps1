Add-Type -AssemblyName System.Drawing

function New-RoundRectPath {
    param([float]$x, [float]$y, [float]$w, [float]$h, [float]$r)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $r*2, $r*2, 180, 90)
    $path.AddArc($x + $w - $r*2, $y, $r*2, $r*2, 270, 90)
    $path.AddArc($x + $w - $r*2, $y + $h - $r*2, $r*2, $r*2, 0, 90)
    $path.AddArc($x, $y + $h - $r*2, $r*2, $r*2, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Badge {
    param([System.Drawing.Graphics]$g, [float]$bx, [float]$by, [float]$bs)
    $r = $bs * 0.22
    $path = New-RoundRectPath -x $bx -y $by -w $bs -h $bs -r $r

    $pt1 = New-Object System.Drawing.PointF -ArgumentList @($bx, $by)
    $pt2X = $bx + $bs
    $pt2Y = $by + $bs
    $pt2 = New-Object System.Drawing.PointF -ArgumentList @($pt2X, $pt2Y)
    $colorA = [System.Drawing.Color]::FromArgb(255,240,182,74)
    $colorB = [System.Drawing.Color]::FromArgb(255,138,90,6)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($pt1, $pt2, $colorA, $colorB)
    $g.FillPath($brush, $path)

    $dark = [System.Drawing.Color]::FromArgb(255,18,20,26)
    $fontSize = [float]($bs * 0.60)
    $font = New-Object System.Drawing.Font -ArgumentList @("Arial", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush -ArgumentList @($dark)
    $rectY = $by + $bs*0.03
    $rect = New-Object System.Drawing.RectangleF -ArgumentList @($bx, $rectY, $bs, $bs)
    $g.DrawString("B", $font, $textBrush, $rect, $sf)

    $penWidth = [float]($bs*0.045)
    $pen = New-Object System.Drawing.Pen -ArgumentList @($dark, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $lineX = $bx + $bs*0.305
    $g.DrawLine($pen, $lineX, ($by+$bs*0.14), $lineX, ($by+$bs*0.30))
    $g.DrawLine($pen, $lineX, ($by+$bs*0.72), $lineX, ($by+$bs*0.88))

    $font.Dispose(); $textBrush.Dispose(); $brush.Dispose(); $path.Dispose(); $pen.Dispose()
}

function New-Icon {
    param([int]$size, [string]$outPath)
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    Draw-Badge -g $g -bx 0 -by 0 -bs $size
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

function New-OgImage {
    param([string]$outPath)
    $w = 1200; $h = 630
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList @($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    $bgPt1 = New-Object System.Drawing.Point -ArgumentList @(0, 0)
    $bgPt2 = New-Object System.Drawing.Point -ArgumentList @($w, $h)
    $bgColorA = [System.Drawing.Color]::FromArgb(255,11,15,20)
    $bgColorB = [System.Drawing.Color]::FromArgb(255,23,16,24)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($bgPt1, $bgPt2, $bgColorA, $bgColorB)
    $g.FillRectangle($bgBrush, 0, 0, $w, $h)

    $gridColor = [System.Drawing.Color]::FromArgb(18,229,165,61)
    $gridPen = New-Object System.Drawing.Pen -ArgumentList @($gridColor)
    for ($gx=40; $gx -lt $w; $gx+=40) { $g.DrawLine($gridPen, $gx, 0, $gx, $h) }
    for ($gy=40; $gy -lt $h; $gy+=40) { $g.DrawLine($gridPen, 0, $gy, $w, $gy) }

    Draw-Badge -g $g -bx 100 -by 130 -bs 170

    $titleFont = New-Object System.Drawing.Font -ArgumentList @("Arial", 66, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $titleColor = [System.Drawing.Color]::FromArgb(255,231,237,243)
    $titleBrush = New-Object System.Drawing.SolidBrush -ArgumentList @($titleColor)
    $g.DrawString("CoinPlay", $titleFont, $titleBrush, 98, 330)

    $subFont = New-Object System.Drawing.Font -ArgumentList @("Arial", 28, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $subColor = [System.Drawing.Color]::FromArgb(255,139,152,168)
    $subBrush = New-Object System.Drawing.SolidBrush -ArgumentList @($subColor)
    $g.DrawString("Simulated BTC trading in real time", $subFont, $subBrush, 100, 410)

    $pillPath = New-RoundRectPath -x 100 -y 470 -w 560 -h 56 -r 28
    $pillColor = [System.Drawing.Color]::FromArgb(36,229,165,61)
    $pillBrush = New-Object System.Drawing.SolidBrush -ArgumentList @($pillColor)
    $g.FillPath($pillBrush, $pillPath)
    $pillFont = New-Object System.Drawing.Font -ArgumentList @("Arial", 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $pillColor2 = [System.Drawing.Color]::FromArgb(255,229,165,61)
    $pillBrush2 = New-Object System.Drawing.SolidBrush -ArgumentList @($pillColor2)
    $pillSf = New-Object System.Drawing.StringFormat
    $pillSf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $pillRect = New-Object System.Drawing.RectangleF -ArgumentList @(128, 470, 520, 56)
    $g.DrawString("Live Binance prices - AI forecast - paper trading", $pillFont, $pillBrush2, $pillRect, $pillSf)

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

$pub = "E:\MyWork\BTC-Paper-Desk\public"
New-Item -ItemType Directory -Force -Path $pub | Out-Null

New-Icon -size 512 -outPath (Join-Path $pub "icon-512.png")
New-Icon -size 180 -outPath (Join-Path $pub "apple-touch-icon.png")
New-Icon -size 32  -outPath (Join-Path $pub "favicon-32.png")
New-Icon -size 16  -outPath (Join-Path $pub "favicon-16.png")
New-OgImage -outPath (Join-Path $pub "og-image.png")

Write-Output "done"
