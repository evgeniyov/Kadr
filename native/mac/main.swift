// kadr-helper — long-lived native helper for Kadr on macOS.
//
// Reads newline-delimited JSON requests on stdin, answers on stdout (one JSON object per
// line, matched by "id"), logs to stderr, and exits when stdin closes. Requests run
// concurrently; images and audio are exchanged as file paths.

import AppKit
import Foundation

signal(SIGPIPE, SIG_IGN)

// One-shot mode: show the system prompt that downloads translation languages.
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--prepare-translation" {
    runPrepareTranslation(arguments: Array(CommandLine.arguments.dropFirst(2)))
}

// Connect to the window server on the main thread before anything else: ScreenCaptureKit
// and CoreGraphics assert (CGS_REQUIRE_INIT) when first used from a background thread.
// `.prohibited` keeps the helper out of the Dock and the app switcher.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

enum Router {
    static func handle(line: String) {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            Log.info("ignoring malformed request line")
            return
        }
        let id = request["id"] ?? NSNull()
        let cmd = request["cmd"] as? String ?? ""
        let args = request["args"] as? Args ?? [:]
        adjustInFlight(+1)
        Task.detached(priority: .userInitiated) {
            defer { adjustInFlight(-1) }
            do {
                Output.reply(id: id, result: try await run(cmd, args))
            } catch {
                let e = describe(error)
                Output.fail(id: id, code: e.code, message: e.message)
            }
        }
    }

    private static let stateLock = NSLock()
    private static var inFlight = 0
    private static var exiting = false

    private static func adjustInFlight(_ delta: Int) {
        stateLock.lock(); defer { stateLock.unlock() }
        inFlight += delta
    }

    private static var pendingRequests: Int {
        stateLock.lock(); defer { stateLock.unlock() }
        return inFlight
    }

    static func run(_ cmd: String, _ args: Args) async throws -> Any {
        switch cmd {
        case "hello": return hello()
        case "permissions": return permissions()
        case "requestScreenAccess": return requestScreenAccess()
        case "detectLanguage": return try detectLanguage(args)
        case "translationStatus": return try await translationStatus(args)
        case "translate": return try await translate(args)
        case "windows": return await listWindows(args)
        case "scroll": return try scroll(args)
        case "ocr": return try await onVisionQueue(retryingReaderErrors: true) { try recognizeText(args) }
        case "barcodes": return try await onVisionQueue { try detectBarcodes(args) }
        case "captureWindow":
            guard #available(macOS 14.0, *) else { throw HelperError.unsupported("captureWindow requires macOS 14") }
            return try await captureWindow(args)
        case "captureDisplays":
            guard #available(macOS 14.0, *) else { throw HelperError.unsupported("captureDisplays requires macOS 14") }
            return try await captureDisplays(args)
        case "prepareCapture":
            guard #available(macOS 14.0, *) else { throw HelperError.unsupported("prepareCapture requires macOS 14") }
            return try await prepareCapture(args)
        case "removeBackground":
            guard #available(macOS 14.0, *) else { throw HelperError.unsupported("removeBackground requires macOS 14") }
            return try await onVisionQueue { try removeBackground(args) }
        case "audioStart": return try await Audio.start(args)
        case "audioPause": return try Audio.pause()
        case "audioResume": return try Audio.resume()
        case "audioStop": return await Audio.stop()
        default: throw HelperError("UNKNOWN_COMMAND", "unknown command '\(cmd)'")
        }
    }

    /// Lets in-flight requests answer and finalises an in-progress audio recording,
    /// then exits (with a hard deadline).
    static func shutdownAndExit(_ reason: String) {
        stateLock.lock()
        if exiting { stateLock.unlock(); return }
        exiting = true
        stateLock.unlock()
        Log.info("\(reason), shutting down")
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { exit(0) }
        Task.detached {
            if Audio.isRunning { _ = await Audio.stop() }
            var waited = 0
            while pendingRequests > 0 && waited < 250 {
                try? await Task.sleep(nanoseconds: 20_000_000)
                waited += 1
            }
            exit(0)
        }
    }
}

let stdinReader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\r" }) { continue }
        Router.handle(line: line)
    }
    Router.shutdownAndExit("stdin closed")
}
stdinReader.name = "kadr-helper.stdin"
stdinReader.start()

signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { Router.shutdownAndExit("SIGTERM") }
sigterm.resume()

// Keep the main run loop alive: NSWorkspace state and main-actor work are serviced here.
RunLoop.main.add(Timer(timeInterval: 86400, repeats: true) { _ in }, forMode: .default)
while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
