// hello / permissions / window list / scroll injection.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func capabilities() -> [String: Any] {
    var mac14 = false
    if #available(macOS 14.0, *) { mac14 = true }
    return [
        "windowList": true,
        "captureWindow": mac14,
        "captureDisplays": mac14,
        "scroll": true,
        "ocr": true,
        "barcodes": true,
        "removeBackground": mac14,
        "systemAudio": true, // SCStream audio: macOS 13+, which is our deployment target
    ]
}

/// Screen Recording permission, checked without ever prompting. The environment switch
/// lets tests exercise the "no permission" paths on a machine that has it.
func hasScreenAccess() -> Bool {
    if ProcessInfo.processInfo.environment["KADR_HELPER_SIMULATE_NO_SCREEN_ACCESS"] == "1" { return false }
    return CGPreflightScreenCaptureAccess()
}

func permissions() -> [String: Any] {
    // Both calls only check; neither ever shows a prompt.
    ["screen": hasScreenAccess(), "accessibility": AXIsProcessTrusted()]
}

/// Asks for Screen Recording access. Shows the system prompt when the status is undetermined
/// and, either way, makes the (responsible) app appear in System Settings → Screen Recording,
/// so the user only has to flip the switch.
func requestScreenAccess() -> [String: Any] {
    ["granted": CGRequestScreenCaptureAccess()]
}

func hello() -> [String: Any] {
    #if arch(arm64)
        let arch = "arm64"
    #else
        let arch = "x86_64"
    #endif
    return [
        "version": helperVersion,
        "os": osVersionString(),
        "arch": arch,
        "pid": Int(getpid()),
        "capabilities": capabilities(),
        "permissions": permissions(),
    ]
}

/// On-screen windows, front-to-back, as reported by the window server.
/// Bounds are in points with a top-left origin on the main display — the same
/// global coordinate space Electron's `screen` module uses on macOS.
func listWindows(_ args: Args) async -> [String: Any] {
    let allLayers = args.bool("allLayers") ?? false
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let info = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []

    var windows: [[String: Any]] = []
    for w in info {
        let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if !allLayers && layer != 0 { continue }
        guard let number = w[kCGWindowNumber as String] as? NSNumber,
              let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }
        windows.append([
            "id": number.uint32Value,
            "pid": (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0,
            "appName": (w[kCGWindowOwnerName as String] as? String) ?? "",
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "bounds": [
                "x": Double(rect.origin.x),
                "y": Double(rect.origin.y),
                "width": Double(rect.width),
                "height": Double(rect.height),
            ],
            "layer": layer,
            "alpha": (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
        ])
    }

    // Active displays in the same coordinate space, so callers can drop windows that are
    // parked off-screen (e.g. the hidden toolbar windows of full-screen apps).
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    let displays: [[String: Any]] = ids.prefix(Int(count)).map { id in
        let b = CGDisplayBounds(id)
        return ["id": Int(id), "bounds": ["x": Double(b.origin.x), "y": Double(b.origin.y),
                                          "width": Double(b.width), "height": Double(b.height)]]
    }

    let front: (pid: Int, name: String)? = await MainActor.run {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return (Int(app.processIdentifier), app.localizedName ?? "")
    }
    return [
        "windows": windows,
        "displays": displays,
        "frontmostPid": front.map { $0.pid as Any } ?? NSNull(),
        "frontmostName": front?.name ?? "",
    ]
}

/// Posts a pixel-precise scroll-wheel event at a global point (points, top-left origin).
/// deltaY > 0 scrolls the content down (like dragging a scrollbar down).
func scroll(_ args: Args) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw HelperError.noAccess("accessibility permission is required to post scroll events")
    }
    let x = try args.requireNumber("x"), y = try args.requireNumber("y")
    let dy = args.number("deltaY") ?? 0, dx = args.number("deltaX") ?? 0
    let point = CGPoint(x: x, y: y)

    // Scroll events are routed to the window under the cursor, so move it there first
    // (only if it is not already there; the position is intentionally not restored).
    if args.bool("warp") ?? true {
        let current = CGEvent(source: nil)?.location ?? .zero
        if abs(current.x - point.x) > 1 || abs(current.y - point.y) > 1 {
            CGWarpMouseCursorPosition(point)
            CGAssociateMouseAndMouseCursorPosition(1)
        }
    }

    // Positive wheel values scroll up / left in CG, hence the sign flip.
    func wheel(_ v: Double) -> Int32 { Int32(max(-100_000, min(100_000, v)).rounded()) }
    let w1 = wheel(-dy), w2 = wheel(-dx)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                              wheel1: w1, wheel2: w2, wheel3: 0)
    else { throw HelperError.failed("cannot create scroll event") }
    event.location = point
    event.post(tap: .cghidEventTap)
    return ["posted": true]
}
