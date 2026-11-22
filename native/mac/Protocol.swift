// JSON-lines protocol plumbing: request arguments, errors, stdout replies, stderr logs.
//
// Request  (stdin):  {"id":1,"cmd":"windows","args":{...}}
// Response (stdout): {"id":1,"ok":true,"result":...}
//                    {"id":1,"ok":false,"error":"message","code":"UNSUPPORTED"}

import Foundation

let helperVersion = "1.0.0"

typealias Args = [String: Any]

struct HelperError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    static func unsupported(_ what: String) -> HelperError { HelperError("UNSUPPORTED", "unsupported: \(what)") }
    static func noAccess(_ what: String) -> HelperError { HelperError("NO_ACCESS", what) }
    static func badArgs(_ what: String) -> HelperError { HelperError("BAD_ARGS", what) }
    static func failed(_ what: String) -> HelperError { HelperError("FAILED", what) }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }

    func requireString(_ key: String) throws -> String {
        guard let s = self[key] as? String, !s.isEmpty else { throw HelperError.badArgs("missing string argument '\(key)'") }
        return s
    }

    func number(_ key: String) -> Double? {
        guard let n = self[key] as? NSNumber else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    func requireNumber(_ key: String) throws -> Double {
        guard let d = number(key) else { throw HelperError.badArgs("missing numeric argument '\(key)'") }
        return d
    }

    func bool(_ key: String) -> Bool? { (self[key] as? NSNumber)?.boolValue }
    func int(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue }
    func ints(_ key: String) -> [Int]? { (self[key] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } }

    func strings(_ key: String) -> [String]? {
        if let a = self[key] as? [String] { return a }
        if let s = self[key] as? String { return s.split(whereSeparator: { $0 == "+" || $0 == "," }).map(String.init) }
        return nil
    }
}

enum Log {
    static func info(_ message: String) {
        fputs("[kadr-helper] \(message)\n", stderr)
    }
}

enum Output {
    private static let lock = NSLock()

    static func reply(id: Any, result: Any) {
        send(["id": id, "ok": true, "result": result])
    }

    static func fail(id: Any, code: String, message: String) {
        send(["id": id, "ok": false, "error": message, "code": code])
    }

    /// Serialises one message as a single line. Uses write(2) directly so a closed pipe
    /// (parent gone) yields EPIPE instead of an Objective-C exception.
    static func send(_ message: [String: Any]) {
        var payload = message
        if !JSONSerialization.isValidJSONObject(payload) {
            payload = ["id": message["id"] ?? NSNull(), "ok": false, "error": "result is not JSON-serialisable", "code": "FAILED"]
        }
        guard var data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes]) else {
            Log.info("failed to serialise reply")
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let n = write(STDOUT_FILENO, base + offset, raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    return
                }
                offset += n
            }
        }
    }
}

/// Vision requests run one at a time: when the system text-recognition service has been
/// unloaded after idling, concurrent requests fail with CRImageReaderError instead of
/// waiting for it to come back.
let visionQueue = DispatchQueue(label: "kadr.vision", qos: .userInitiated)

func onVisionQueue<T>(retryingReaderErrors: Bool = false, _ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { cont in
        visionQueue.async {
            do { cont.resume(returning: try work()) } catch {
                guard retryingReaderErrors, String(describing: error).contains("CRImageReaderError") else {
                    return cont.resume(throwing: error)
                }
                do { cont.resume(returning: try work()) } catch { cont.resume(throwing: error) }
            }
        }
    }
}

/// Runs blocking work (Vision, file IO) off the Swift concurrency pool.
func onWorkQueue<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { cont in
        DispatchQueue.global(qos: .userInitiated).async {
            do { cont.resume(returning: try work()) } catch { cont.resume(throwing: error) }
        }
    }
}

func rounded(_ v: Double, _ digits: Double = 10) -> Double {
    (v * digits).rounded() / digits
}

/// Normalised Vision rect (origin bottom-left) -> image pixels with a top-left origin.
func pixelBox(_ r: CGRect, width: Int, height: Int) -> [String: Any] {
    let w = Double(width), h = Double(height)
    return [
        "x": rounded(Double(r.minX) * w),
        "y": rounded((1 - Double(r.maxY)) * h),
        "width": rounded(Double(r.width) * w),
        "height": rounded(Double(r.height) * h),
    ]
}

/// Maps framework errors to protocol errors (permission problems become NO_ACCESS).
func describe(_ error: Error) -> HelperError {
    if let e = error as? HelperError { return e }
    let ns = error as NSError
    // ScreenCaptureKit can report userDeclined after a service interruption even
    // though the helper still passes the system permission check.
    if ns.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && ns.code == -3801 {
        if !hasScreenAccess() { return HelperError.noAccess("screen recording permission denied") }
        return HelperError.failed("ScreenCaptureKit refused capture with screen recording permission granted [\(ns.domain) \(ns.code)]")
    }
    return HelperError.failed("\(ns.localizedDescription) [\(ns.domain) \(ns.code)]")
}
