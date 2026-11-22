// Window and display screenshots via ScreenCaptureKit (macOS 14+).

import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

/// Never call ScreenCaptureKit without permission: that would show the system prompt.
func requireScreenAccess() throws {
    guard hasScreenAccess() else {
        throw HelperError.noAccess("screen recording permission is not granted")
    }
}

func writePNG(_ image: CGImage, to path: String, scale: Double = 1) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw HelperError.failed("cannot create \(path)")
    }
    // 72 dpi per point, like macOS screenshots (144 dpi on Retina).
    let dpi = 72 * max(scale, 1)
    let props: [CFString: Any] = [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi]
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError.failed("cannot write \(path)") }
}

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

/// Re-renders an image into sRGB (keeps alpha) so every PNG we hand out has the same
/// colour space regardless of the display it came from.
func toSRGB(_ image: CGImage) -> CGImage {
    if image.colorSpace?.name == CGColorSpace.sRGB { return image }
    guard let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: srgb,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return image }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return ctx.makeImage() ?? image
}

@available(macOS 14.0, *)
func baseConfiguration(width: Int, height: Int, cursor: Bool) -> SCStreamConfiguration {
    let cfg = SCStreamConfiguration()
    cfg.width = max(width, 1)
    cfg.height = max(height, 1)
    cfg.captureResolution = .best
    cfg.showsCursor = cursor
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.colorSpaceName = CGColorSpace.sRGB
    cfg.scalesToFit = false
    return cfg
}

@available(macOS 14.0, *)
func findWindow(_ id: CGWindowID) async throws -> SCWindow {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == id }) else {
        throw HelperError("NOT_FOUND", "window \(id) not found")
    }
    return window
}

/// captureWindow {id, shadow, out, children?} -> {path, pixelWidth, pixelHeight, scale}
/// Child windows are excluded by default: full-screen apps keep hidden toolbar child
/// windows above the screen that would otherwise enlarge the image.
@available(macOS 14.0, *)
func captureWindow(_ args: Args) async throws -> [String: Any] {
    try requireScreenAccess()
    guard let id = CGWindowID(exactly: try args.requireNumber("id")) else {
        throw HelperError("NOT_FOUND", "invalid window id")
    }
    let shadow = args.bool("shadow") ?? true
    let out = try args.requireString("out")

    let window = try await findWindow(id)
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let info = SCShareableContent.info(for: filter)
    let scale = Double(info.pointPixelScale)

    var image: CGImage
    let mode = args.string("mode") ?? "auto"
    if #available(macOS 26.0, *), mode != "stream" {
        // The screenshot configuration sizes the output to the content itself,
        // including the shadow margin when shadows are requested.
        let cfg = SCScreenshotConfiguration()
        cfg.showsCursor = false
        cfg.ignoreShadows = !shadow
        cfg.includeChildWindows = args.bool("children") ?? false
        cfg.dynamicRange = .sdr
        let output = try await SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: cfg)
        guard let sdr = output.sdrImage else { throw HelperError.failed("empty screenshot") }
        image = toSRGB(sdr)
    } else {
        image = try await captureWindowWithStreamConfig(filter: filter, info: info, shadow: shadow,
                                                      includeChildren: args.bool("children") ?? false)
    }
    try writePNG(image, to: out, scale: scale)
    return ["path": out, "pixelWidth": image.width, "pixelHeight": image.height, "scale": scale]
}

/// macOS 14–15 path. `contentRect` excludes the shadow, and the stream configuration
/// clips whatever does not fit, so with shadows we render into a generously enlarged
/// canvas (no scaling) and trim the fully transparent margin afterwards.
@available(macOS 14.0, *)
func captureWindowWithStreamConfig(filter: SCContentFilter, info: SCShareableContentInfo, shadow: Bool,
                                   includeChildren: Bool) async throws -> CGImage {
    let scale = CGFloat(info.pointPixelScale)
    let margin: CGFloat = shadow ? 80 : 0 // points on every side, more than any window shadow
    let cfg = baseConfiguration(width: Int(((info.contentRect.width + 2 * margin) * scale).rounded()),
                                height: Int(((info.contentRect.height + 2 * margin) * scale).rounded()),
                                cursor: false)
    cfg.ignoreShadowsSingleWindow = !shadow
    if #available(macOS 14.2, *) { cfg.includeChildWindows = includeChildren }
    cfg.shouldBeOpaque = false
    cfg.backgroundColor = .clear
    cfg.scalesToFit = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return shadow ? trimTransparentEdges(image) : image
}

/// Crops rows/columns whose pixels are all fully transparent.
func trimTransparentEdges(_ image: CGImage) -> CGImage {
    let w = image.width, h = image.height
    guard w > 0, h > 0,
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let data = ctx.data
    else { return image }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    let px = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0 ..< h {
        let row = px + y * w * 4
        for x in 0 ..< w where row[x * 4 + 3] != 0 {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            maxY = y
        }
    }
    guard maxX >= minX, maxY >= minY else { return image }
    // The bitmap context's rows are top-down in memory, matching CGImage cropping coordinates.
    return image.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)) ?? image
}

// ---- Display capture -----------------------------------------------------------------
//
// The frame must be grabbed as close to the hotkey as possible. Fetching SCShareableContent
// took most of that time (20–50 ms, twice), so it is kept ready: `prepareCapture` fetches it
// when Kadr's overlay windows or the displays change, and a capture only grabs the frame.
// A cached list is enough: a capture needs the displays and the windows to leave out, and
// everything else on screen is in the frame anyway ("this display minus these windows").

@available(macOS 14.0, *)
actor ShareableContentCache {
    static let shared = ShareableContentCache()
    private var content: SCShareableContent?
    private var refreshInFlight: Task<SCShareableContent, Error>?

    /// The cached content, if it still has the current displays and every window in `windowIds`.
    func cached(having windowIds: Set<Int>) -> SCShareableContent? {
        guard let c = content else { return nil }
        guard Set(c.displays.map { $0.displayID }) == activeDisplayIDs() else { return nil }
        if windowIds.isEmpty { return c }
        return windowIds.isSubset(of: Set(c.windows.map { Int($0.windowID) })) ? c : nil
    }

    @discardableResult
    func refresh() async throws -> SCShareableContent {
        if let refreshInFlight { return try await refreshInFlight.value }
        // All windows: Kadr's overlays are still hidden when they are left out of a capture.
        let task = Task {
            try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        }
        refreshInFlight = task
        defer { refreshInFlight = nil }
        let updated = try await task.value
        content = updated
        return updated
    }
}

private func activeDisplayIDs() -> Set<CGDirectDisplayID> {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return Set(ids.prefix(Int(count)))
}

/// prepareCapture {} -> {displays}: makes the next captureDisplays grab the frame right away.
@available(macOS 14.0, *)
func prepareCapture(_ args: Args) async throws -> [String: Any] {
    try requireScreenAccess()
    // Prime metadata only. A throwaway frame can start a second capture session
    // while a real screenshot is being taken.
    let content = try await ShareableContentCache.shared.refresh()
    return ["displays": content.displays.count]
}

@available(macOS 14.0, *)
private func captureDisplayImage(filter: SCContentFilter, width: Int, height: Int, cursor: Bool) async throws -> CGImage {
    if #available(macOS 26.0, *) {
        // Use the dedicated still-image API on recent macOS, as for window captures.
        let cfg = SCScreenshotConfiguration()
        cfg.width = max(width, 1)
        cfg.height = max(height, 1)
        cfg.showsCursor = cursor
        cfg.dynamicRange = .sdr
        let output = try await SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: cfg)
        guard let image = output.sdrImage else { throw HelperError.failed("empty display screenshot") }
        return toSRGB(image)
    }
    let cfg = baseConfiguration(width: width, height: height, cursor: cursor)
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
}

/// captureDisplays {cursor, dir, excludeWindowIds?, excludePid?} -> [{displayId, path, pixelWidth, pixelHeight, scale}]
@available(macOS 14.0, *)
func captureDisplays(_ args: Args) async throws -> [[String: Any]] {
    try requireScreenAccess()
    let started = Date()
    let windowIds = Set(args.ints("excludeWindowIds") ?? [])
    let cache = ShareableContentCache.shared
    // A display or window in the cached list may be gone by now: then fetch it again.
    if let content = await cache.cached(having: windowIds),
       let shots = try? await captureDisplays(args, content: content, windowIds: windowIds, started: started) {
        return shots
    }
    return try await captureDisplays(args, content: try await cache.refresh(), windowIds: windowIds, started: started)
}

@available(macOS 14.0, *)
private func captureDisplays(_ args: Args, content: SCShareableContent, windowIds: Set<Int>, started: Date) async throws -> [[String: Any]] {
    let cursor = args.bool("cursor") ?? false
    let dir = try args.requireString("dir")
    let stamp = Int(Date().timeIntervalSince1970 * 1000)

    // The caller may already show its own overlay on screen: leave those windows (or that
    // whole app) out.
    let excludedWindows = content.windows.filter { windowIds.contains(Int($0.windowID)) }
    if excludedWindows.count < windowIds.count { throw HelperError("FAILED", "windows to exclude not found") }
    var excludedApps: [SCRunningApplication] = []
    if let pid = args.int("excludePid") { excludedApps = content.applications.filter { $0.processID == pid } }

    return try await withThrowingTaskGroup(of: [String: Any].self) { group in
        for display in content.displays {
            group.addTask {
                let filter = excludedApps.isEmpty
                    ? SCContentFilter(display: display, excludingWindows: excludedWindows)
                    : SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
                let scale = Double(SCShareableContent.info(for: filter).pointPixelScale)
                let image = try await captureDisplayImage(
                    filter: filter,
                    width: Int((Double(display.width) * scale).rounded()),
                    height: Int((Double(display.height) * scale).rounded()),
                    cursor: cursor
                )
                let grabMs = Int(Date().timeIntervalSince(started) * 1000)
                let path = (dir as NSString).appendingPathComponent("display-\(display.displayID)-\(stamp).png")
                try writePNG(image, to: path, scale: scale)
                return [
                    "displayId": Int(display.displayID),
                    "path": path,
                    "pixelWidth": image.width,
                    "pixelHeight": image.height,
                    "scale": scale,
                    "grabMs": grabMs, // request → frame grabbed (how late after the hotkey)
                ]
            }
        }
        var results: [[String: Any]] = []
        for try await r in group { results.append(r) }
        // Main display first, then the window server's order.
        let order = content.displays.map { Int($0.displayID) }
        let main = Int(CGMainDisplayID())
        func rank(_ r: [String: Any]) -> Int {
            let id = r["displayId"] as? Int ?? 0
            return id == main ? -1 : (order.firstIndex(of: id) ?? order.count)
        }
        return results.sorted { rank($0) < rank($1) }
    }
}
