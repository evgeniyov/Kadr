// Text recognition, barcode detection and subject lifting via the Vision framework.

import CoreImage
import Foundation
import ImageIO
import Vision

func loadImage(_ path: String) throws -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { throw HelperError("BAD_IMAGE", "cannot read image \(path)") }
    return image
}

/// Picks the requested languages Vision supports, accepting "ru" for "ru-RU" etc.
func resolveLanguages(_ requested: [String], supported: [String]) -> [String] {
    var picked: [String] = []
    for lang in requested {
        let l = lang.replacingOccurrences(of: "_", with: "-")
        let match = supported.first { $0.caseInsensitiveCompare(l) == .orderedSame }
            ?? supported.first { $0.lowercased().hasPrefix(l.lowercased() + "-") }
            ?? supported.first { $0.split(separator: "-").first?.lowercased() == l.split(separator: "-").first?.lowercased() }
        if let m = match, !picked.contains(m) { picked.append(m) }
    }
    return picked
}

/// ocr {path, languages, fast, autoDetect} -> {width, height, languages, lines:[{text, confidence, box}]}
func recognizeText(_ args: Args) throws -> [String: Any] {
    let image = try loadImage(try args.requireString("path"))
    let fast = args.bool("fast") ?? false

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = true
    var languages: [String] = []
    if let requested = args.strings("languages"), !requested.isEmpty {
        // The fast model only knows Latin-script languages; use the accurate one when a
        // requested language (e.g. Russian) would otherwise come out as gibberish.
        if fast, resolveLanguages(requested, supported: (try? request.supportedRecognitionLanguages()) ?? []).count < requested.count {
            request.recognitionLevel = .accurate
        }
        let supported = (try? request.supportedRecognitionLanguages()) ?? []
        languages = resolveLanguages(requested, supported: supported)
        if !languages.isEmpty { request.recognitionLanguages = languages }
    }
    // Explicit languages give the best results for mixed ru/en text; auto-detection is
    // used when the caller did not ask for specific languages (or asks for it).
    request.automaticallyDetectsLanguage = args.bool("autoDetect") ?? languages.isEmpty

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let lines: [[String: Any]] = (request.results ?? []).compactMap { obs in
        guard let top = obs.topCandidates(1).first else { return nil }
        return [
            "text": top.string,
            "confidence": rounded(Double(top.confidence), 1000),
            "box": pixelBox(obs.boundingBox, width: image.width, height: image.height),
        ]
    }
    return [
        "width": image.width,
        "height": image.height,
        "level": request.recognitionLevel == .fast ? "fast" : "accurate",
        "languages": languages,
        "lines": lines,
    ]
}

/// barcodes {path} -> {width, height, codes:[{text, symbology, box}]}
func detectBarcodes(_ args: Args) throws -> [String: Any] {
    let image = try loadImage(try args.requireString("path"))
    let request = VNDetectBarcodesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    var seen: [(text: String, box: CGRect)] = []
    var codes: [[String: Any]] = []
    for obs in request.results ?? [] {
        guard let text = obs.payloadStringValue else { continue }
        // Vision may report the same symbol twice (e.g. QR and MicroQR passes).
        if seen.contains(where: { $0.text == text && $0.box.intersects(obs.boundingBox) }) { continue }
        seen.append((text, obs.boundingBox))
        let symbology = obs.symbology.rawValue.replacingOccurrences(of: "VNBarcodeSymbology", with: "")
        codes.append([
            "text": text,
            "symbology": symbology,
            "confidence": rounded(Double(obs.confidence), 1000),
            "box": pixelBox(obs.boundingBox, width: image.width, height: image.height),
        ])
    }
    return ["width": image.width, "height": image.height, "codes": codes]
}

let sharedCIContext = CIContext(options: [.cacheIntermediates: false])

/// removeBackground {path, out} -> {path, pixelWidth, pixelHeight, instances}
@available(macOS 14.0, *)
func removeBackground(_ args: Args) throws -> [String: Any] {
    let image = try loadImage(try args.requireString("path"))
    let out = try args.requireString("out")

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([request])
    guard let obs = request.results?.first, !obs.allInstances.isEmpty else {
        throw HelperError("NO_SUBJECT", "no foreground subject found")
    }
    let masked = try obs.generateMaskedImage(ofInstances: obs.allInstances, from: handler, croppedToInstancesExtent: false)
    let ci = CIImage(cvPixelBuffer: masked)
    guard let cg = sharedCIContext.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: srgb) else {
        throw HelperError.failed("cannot render masked image")
    }
    try writePNG(cg, to: out)
    return ["path": out, "pixelWidth": cg.width, "pixelHeight": cg.height, "instances": obs.allInstances.count]
}
