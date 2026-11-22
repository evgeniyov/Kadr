// Regenerates the OCR / QR / subject fixtures: swift make-fixtures.swift <outDir>
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
func save(_ rep: NSBitmapImageRep, _ name: String) {
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
}
func canvas(_ w: Int, _ h: Int, _ draw: () -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    return rep
}
// 1. text + QR
let qrFilter = CIFilter.qrCodeGenerator()
qrFilter.message = "https://kadr.app/test?q=Привет".data(using: .utf8)!
qrFilter.correctionLevel = "M"
let qr = qrFilter.outputImage!.transformed(by: CGAffineTransform(scaleX: 5, y: 5))
let ctx = CIContext()
let qrCG = ctx.createCGImage(qr, from: qr.extent)!
let text = canvas(1100, 420) {
    NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1100, height: 420).fill()
    let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black]
    ("Привет, мир! Это тест распознавания." as NSString).draw(at: NSPoint(x: 30, y: 350), withAttributes: a)
    ("Hello world, OCR test 12345." as NSString).draw(at: NSPoint(x: 30, y: 280), withAttributes: a)
    ("Съешь же ещё этих мягких французских булок" as NSString).draw(at: NSPoint(x: 30, y: 210), withAttributes: a)
    NSGraphicsContext.current!.cgContext.draw(qrCG, in: CGRect(x: 30, y: 10, width: qrCG.width, height: qrCG.height))
}
save(text, "ocr-ru-en-qr.png")
// 2. subject on background
let subj = canvas(480, 360) {
    let g = NSGradient(starting: NSColor(calibratedRed: 0.55, green: 0.75, blue: 0.9, alpha: 1), ending: NSColor(calibratedRed: 0.9, green: 0.9, blue: 0.75, alpha: 1))!
    g.draw(in: NSRect(x: 0, y: 0, width: 480, height: 360), angle: 90)
    let badge = NSBezierPath(ovalIn: NSRect(x: 133, y: 73, width: 214, height: 214))
    let badgeGradient = NSGradient(
        starting: NSColor(calibratedRed: 0.10, green: 0.22, blue: 0.44, alpha: 1),
        ending: NSColor(calibratedRed: 0.35, green: 0.16, blue: 0.57, alpha: 1)
    )!
    badgeGradient.draw(in: badge, angle: 35)

    NSColor(calibratedRed: 1, green: 0.76, blue: 0.32, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: 253, y: 198, width: 42, height: 42)).fill()

    let mountain = NSBezierPath()
    mountain.move(to: NSPoint(x: 159, y: 131))
    mountain.line(to: NSPoint(x: 216, y: 218))
    mountain.line(to: NSPoint(x: 263, y: 163))
    mountain.line(to: NSPoint(x: 281, y: 182))
    mountain.line(to: NSPoint(x: 321, y: 131))
    mountain.close()
    NSColor(calibratedRed: 0.44, green: 0.93, blue: 0.83, alpha: 1).setFill()
    mountain.fill()
}
save(subj, "subject.png")
print("fixtures written to", outDir)
