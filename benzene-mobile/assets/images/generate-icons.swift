import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

private func makeContext(size: Int, background: NSColor?) -> CGContext {
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let context = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  context.setShouldAntialias(true)
  context.setAllowsAntialiasing(true)
  if let background {
    context.setFillColor(background.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
  }
  return context
}

private func drawMark(in context: CGContext, size: Int, color: CGColor) {
  let center = CGFloat(size) / 2
  // Keep the complete mark inside Android's adaptive-icon safe circle.
  let outerRadius = CGFloat(size) * 0.315
  let hexRadius = outerRadius * 0.75
  let innerRadius = outerRadius * 0.405
  let scale = CGFloat(size) / 432

  context.setStrokeColor(color)
  context.setLineCap(.round)
  context.setLineJoin(.round)

  context.setLineWidth(4 * scale)
  context.addEllipse(in: CGRect(
    x: center - outerRadius,
    y: center - outerRadius,
    width: outerRadius * 2,
    height: outerRadius * 2
  ))
  context.strokePath()

  let vertices = (0..<6).map { index -> CGPoint in
    let angle = CGFloat(-90 + index * 60) * .pi / 180
    return CGPoint(
      x: center + hexRadius * cos(angle),
      y: center + hexRadius * sin(angle)
    )
  }
  let hexagon = CGMutablePath()
  hexagon.move(to: vertices[0])
  for vertex in vertices.dropFirst() { hexagon.addLine(to: vertex) }
  hexagon.closeSubpath()
  context.setLineWidth(7 * scale)
  context.addPath(hexagon)
  context.strokePath()

  context.setLineWidth(4 * scale)
  context.setLineDash(phase: 0, lengths: [innerRadius * 0.35, innerRadius * 0.2])
  context.addEllipse(in: CGRect(
    x: center - innerRadius,
    y: center - innerRadius,
    width: innerRadius * 2,
    height: innerRadius * 2
  ))
  context.strokePath()
  context.setLineDash(phase: 0, lengths: [])
}

private func writePNG(to path: String, size: Int, background: NSColor?, markColor: NSColor) throws {
  let context = makeContext(size: size, background: background)
  drawMark(in: context, size: size, color: markColor.cgColor)
  guard let image = context.makeImage(),
        let destination = CGImageDestinationCreateWithURL(
          URL(fileURLWithPath: path) as CFURL,
          UTType.png.identifier as CFString,
          1,
          nil
        ) else {
    throw NSError(domain: "BenzeneIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create PNG at \(path)"])
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(domain: "BenzeneIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not write PNG at \(path)"])
  }
}

let outputDirectory = CommandLine.arguments.dropFirst().first ?? "."
let cream = NSColor(srgbRed: 247 / 255, green: 247 / 255, blue: 245 / 255, alpha: 1)
let ink = NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 23 / 255, alpha: 1)

do {
  try writePNG(to: "\(outputDirectory)/icon.png", size: 1024, background: cream, markColor: ink)
  try writePNG(to: "\(outputDirectory)/android-icon-foreground.png", size: 432, background: nil, markColor: ink)
  try writePNG(to: "\(outputDirectory)/android-icon-monochrome.png", size: 432, background: nil, markColor: .black)
} catch {
  fputs("\(error.localizedDescription)\n", stderr)
  exit(1)
}
