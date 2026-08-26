# Generates MAV Health app icons (PNG) using System.Drawing — no Node required.
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\assets"
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-Icon([int]$size, [string]$path, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # background gradient (indigo -> violet)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 79, 79, 229),
    [System.Drawing.Color]::FromArgb(255, 139, 92, 246),
    45.0)

  if ($rounded) {
    $r = [int]($size * 0.22)
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $gp.AddArc(0, 0, $d, $d, 180, 90)
    $gp.AddArc($size - $d, 0, $d, $d, 270, 90)
    $gp.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $gp.AddArc(0, $size - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($brush, $gp)
  } else {
    $g.FillRectangle($brush, $rect)
  }

  # heartbeat line
  $penW = [Math]::Max(3, $size * 0.045)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $midY = $size * 0.42
  $pts = @(
    (New-Object System.Drawing.PointF(($size * 0.14), $midY)),
    (New-Object System.Drawing.PointF(($size * 0.34), $midY)),
    (New-Object System.Drawing.PointF(($size * 0.43), ($size * 0.26))),
    (New-Object System.Drawing.PointF(($size * 0.55), ($size * 0.56))),
    (New-Object System.Drawing.PointF(($size * 0.63), $midY)),
    (New-Object System.Drawing.PointF(($size * 0.86), $midY))
  )
  $g.DrawLines($pen, $pts)

  # MAV wordmark
  $fontSize = [float]($size * 0.20)
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $textRect = New-Object System.Drawing.RectangleF(0, ($size * 0.58), $size, ($size * 0.30))
  $g.DrawString("MAV", $font, [System.Drawing.Brushes]::White, $textRect, $sf)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $path"
}

New-Icon 192 (Join-Path $outDir "icon-192.png") $true
New-Icon 512 (Join-Path $outDir "icon-512.png") $true
# iOS composes its own corner radius, so the touch icon is square
New-Icon 180 (Join-Path $outDir "apple-touch-icon.png") $false
