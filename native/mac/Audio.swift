// System audio capture: ScreenCaptureKit SCStream (audio only; a 2x2 px / 1 fps video
// stream is required by the API and ignored) -> AAC .m4a via AVAssetWriter.
//
// Timeline rules (output file):
// - it starts at the moment capture started (leading silence is written if the system
//   delivers the first buffer late), so `startedAt` is the wall-clock time of sample 0;
// - paused intervals are cut out (they are measured on the host clock, which is also the
//   clock of the sample timestamps, so buffers in flight are classified correctly);
// - holes in the delivered audio (> 50 ms) are filled with silence, so the file stays in
//   sync with a video recorded over the same period.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let url: URL
    private let queue = DispatchQueue(label: "kadr.audio.samples")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?

    // Timeline state, only touched on `queue` (or before capture starts).
    private var sessionStart = CMTime.invalid // host time of sample 0
    private var nextPTS = CMTime.invalid // end of the audio written so far (output timeline)
    private var writerStarted = false
    private var pauses: [(start: CMTime, end: CMTime?)] = []
    private var finishing = false
    private var stopAt = CMTime.invalid // host time of the stop request; later audio is cut
    private var latestPTS = CMTime.invalid // newest buffer seen (even if dropped)
    private var sampleRate: Int32 = 48000
    private var buffers = 0
    private var dropped = 0
    private var silenceFrames: Int64 = 0
    private(set) var startedAtMs: Double = 0

    init(url: URL) { self.url = url }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw HelperError.failed("no display to attach the audio stream to")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false

        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192_000,
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw HelperError.failed("cannot add an audio input to the writer") }
        writer.add(input)
        self.writer = writer
        self.input = input

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        // A screen output is registered too, otherwise SCStream logs every dropped frame.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        sessionStart = hostNow()
        nextPTS = sessionStart
        startedAtMs = Date().timeIntervalSince1970 * 1000
        try await stream.startCapture()
        self.stream = stream
    }

    // MARK: pause / resume (host clock)

    func pause() {
        queue.sync {
            if pauses.last.map({ $0.end != nil }) ?? true { pauses.append((hostNow(), nil)) }
        }
    }

    func resume() {
        queue.sync {
            if let last = pauses.last, last.end == nil { pauses[pauses.count - 1].end = hostNow() }
        }
    }

    var isPaused: Bool { queue.sync { pauses.last.map { $0.end == nil } ?? false } }

    private func inPause(_ t: CMTime) -> Bool {
        pauses.contains { t >= $0.start && ($0.end == nil || t < $0.end!) }
    }

    private func pausedDuration(before t: CMTime) -> CMTime {
        pauses.reduce(CMTime.zero) { acc, p in
            guard let end = p.end, end <= t else { return acc }
            return CMTimeAdd(acc, CMTimeSubtract(end, p.start))
        }
    }

    // MARK: sample handling

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        handleAudio(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.info("system audio stream stopped: \(error.localizedDescription)")
    }

    private func handleAudio(_ sb: CMSampleBuffer) {
        guard !finishing, let writer = writer, let input = input, sb.isValid, CMSampleBufferDataIsReady(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        guard pts.isValid else { return }
        latestPTS = pts
        if stopAt.isValid && pts >= stopAt { return }
        guard !inPause(pts) else { return }
        buffers += 1

        if let fmt = CMSampleBufferGetFormatDescription(sb),
           let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee, asbd.mSampleRate > 0 {
            sampleRate = Int32(asbd.mSampleRate)
        }
        if !writerStarted {
            guard writer.startWriting() else {
                Log.info("audio writer failed to start: \(writer.error?.localizedDescription ?? "?")")
                finishing = true
                return
            }
            writer.startSession(atSourceTime: sessionStart)
            writerStarted = true
        }

        let target = CMTimeSubtract(pts, pausedDuration(before: pts))
        let gap = CMTimeGetSeconds(CMTimeSubtract(target, nextPTS))
        if gap > 0.05 { appendSilence(seconds: min(gap, 1800), like: sb) }

        guard let timed = retimed(sb, to: nextPTS) else { return }
        guard input.isReadyForMoreMediaData else {
            dropped += 1 // not advancing nextPTS: the gap check re-syncs with silence
            return
        }
        if input.append(timed) {
            nextPTS = CMTimeAdd(nextPTS, CMTime(value: CMTimeValue(CMSampleBufferGetNumSamples(sb)), timescale: sampleRate))
        } else {
            Log.info("audio append failed: \(writer.error?.localizedDescription ?? "?")")
        }
    }

    private func retimed(_ sb: CMSampleBuffer, to pts: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr,
              count > 0 else { return nil }
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count) == noErr
        else { return nil }
        let delta = CMTimeSubtract(pts, CMSampleBufferGetPresentationTimeStamp(sb))
        for i in 0 ..< timing.count {
            timing[i].presentationTimeStamp = CMTimeAdd(timing[i].presentationTimeStamp, delta)
            timing[i].decodeTimeStamp = .invalid
        }
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sb,
                                                    sampleTimingEntryCount: count, sampleTimingArray: &timing,
                                                    sampleBufferOut: &out) == noErr
        else { return nil }
        return out
    }

    /// Writes `seconds` of silence (same PCM format as `like`) at nextPTS.
    private func appendSilence(seconds: Double, like sb: CMSampleBuffer) {
        guard let input = input, let fmt = CMSampleBufferGetFormatDescription(sb) else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: fmt)
        var remaining = Int64((seconds * Double(sampleRate)).rounded())
        let chunk = Int64(sampleRate) / 2
        while remaining > 0 {
            let n = min(remaining, chunk)
            guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else { return }
            pcm.frameLength = AVAudioFrameCount(n)
            for buf in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList) {
                if let p = buf.mData { memset(p, 0, Int(buf.mDataByteSize)) }
            }
            var silent: CMSampleBuffer?
            guard CMAudioSampleBufferCreateWithPacketDescriptions(
                allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil,
                refcon: nil, formatDescription: fmt, sampleCount: CMItemCount(n), presentationTimeStamp: nextPTS,
                packetDescriptions: nil, sampleBufferOut: &silent) == noErr,
                let s = silent,
                CMSampleBufferSetDataBufferFromAudioBufferList(s, blockBufferAllocator: kCFAllocatorDefault,
                                                               blockBufferMemoryAllocator: kCFAllocatorDefault,
                                                               flags: 0, bufferList: pcm.audioBufferList) == noErr
            else { return }
            guard waitUntilReady(input), input.append(s) else { return }
            nextPTS = CMTimeAdd(nextPTS, CMTime(value: CMTimeValue(n), timescale: sampleRate))
            silenceFrames += n
            remaining -= n
        }
    }

    private func waitUntilReady(_ input: AVAssetWriterInput) -> Bool {
        for _ in 0 ..< 100 where !input.isReadyForMoreMediaData { usleep(2000) }
        return input.isReadyForMoreMediaData
    }

    // MARK: stop

    /// Stops capture and finalises the file. Returns nil when no audio was ever delivered.
    /// Audio up to the moment of the call is kept: buffers still in flight (the system
    /// delivers them with some latency) are awaited briefly before the stream is stopped.
    func stop() async -> [String: Any]? {
        let now = hostNow()
        queue.sync { stopAt = now }
        for _ in 0 ..< 25 {
            let caughtUp = queue.sync { latestPTS.isValid && latestPTS >= now }
            if caughtUp || stream == nil { break }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        if let stream = stream { try? await stream.stopCapture() }
        stream = nil
        return await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            queue.async {
                self.finishing = true
                guard let writer = self.writer, self.writerStarted, writer.status == .writing else {
                    if let w = self.writer, w.status == .writing { w.cancelWriting() }
                    try? FileManager.default.removeItem(at: self.url)
                    Log.info("system audio: no audio was captured (\(self.buffers) buffers)")
                    cont.resume(returning: nil)
                    return
                }
                self.input?.markAsFinished()
                writer.endSession(atSourceTime: self.nextPTS)
                let durationMs = CMTimeGetSeconds(CMTimeSubtract(self.nextPTS, self.sessionStart)) * 1000
                let stats: [String: Any] = [
                    "path": self.url.path,
                    "startedAt": self.startedAtMs.rounded(),
                    "durationMs": durationMs.rounded(),
                    "buffers": self.buffers,
                    "dropped": self.dropped,
                    "silenceMs": (Double(self.silenceFrames) / Double(self.sampleRate) * 1000).rounded(),
                ]
                writer.finishWriting {
                    if writer.status == .completed {
                        cont.resume(returning: stats)
                    } else {
                        Log.info("system audio: finishWriting failed: \(writer.error?.localizedDescription ?? "?")")
                        cont.resume(returning: nil)
                    }
                }
            }
        }
    }
}

/// Single active recording, shared by the audio* commands.
enum Audio {
    private static let lock = NSLock()
    private static var recorder: SystemAudioRecorder?

    private static func current() -> SystemAudioRecorder? {
        lock.lock(); defer { lock.unlock() }
        return recorder
    }

    private static func claim(_ r: SystemAudioRecorder) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if recorder != nil { return false }
        recorder = r
        return true
    }

    private static func take() -> SystemAudioRecorder? {
        lock.lock(); defer { lock.unlock() }
        let r = recorder
        recorder = nil
        return r
    }

    static func start(_ args: Args) async throws -> [String: Any] {
        try requireScreenAccess()
        let out = try args.requireString("out")
        let rec = SystemAudioRecorder(url: URL(fileURLWithPath: out))
        guard claim(rec) else { throw HelperError("BUSY", "system audio capture is already running") }
        do {
            try await rec.start()
        } catch {
            _ = take()
            throw describe(error)
        }
        return ["path": out, "startedAt": rec.startedAtMs.rounded()]
    }

    static func pause() throws -> [String: Any] {
        guard let r = current() else { throw HelperError("NOT_RUNNING", "system audio capture is not running") }
        r.pause()
        return ["paused": true]
    }

    static func resume() throws -> [String: Any] {
        guard let r = current() else { throw HelperError("NOT_RUNNING", "system audio capture is not running") }
        r.resume()
        return ["paused": false]
    }

    static func stop() async -> Any {
        guard let r = take() else { return NSNull() }
        return await r.stop() ?? NSNull()
    }

    static var isRunning: Bool { current() != nil }
}
