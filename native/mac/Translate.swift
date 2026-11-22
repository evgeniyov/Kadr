// On-device translation with Apple's Translation framework (no network, text stays on the
// Mac). Language models are managed by macOS and shared with Safari / the Translate app.

import AppKit
import Foundation
import NaturalLanguage
import SwiftUI
import Translation

/// detectLanguage {text} -> {language: "en" | "ru" | …, confidence}
func detectLanguage(_ args: Args) throws -> [String: Any] {
    let text = try args.requireString("text")
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let lang = recognizer.dominantLanguage else { return ["language": NSNull(), "confidence": 0] }
    let confidence = recognizer.languageHypotheses(withMaximum: 1)[lang] ?? 0
    return ["language": lang.rawValue, "confidence": rounded(confidence, 100)]
}

private func languageStatusName(_ from: String, _ to: String) async -> String {
    guard #available(macOS 15.0, *) else { return "unsupported" }
    let status = await LanguageAvailability().status(from: Locale.Language(identifier: from), to: Locale.Language(identifier: to))
    switch status {
    case .installed: return "installed"
    case .supported: return "supported" // available, but the models are not downloaded yet
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
}

/// translationStatus {from, to} -> {status: installed | supported | unsupported}
func translationStatus(_ args: Args) async throws -> [String: Any] {
    ["status": await languageStatusName(try args.requireString("from"), try args.requireString("to"))]
}

/// translate {texts: [String], from, to} -> {texts: [String]} (same order)
func translate(_ args: Args) async throws -> [String: Any] {
    guard #available(macOS 26.0, *) else { throw HelperError.unsupported("translation needs macOS 26") }
    let texts = args.strings("texts") ?? []
    let from = try args.requireString("from")
    let to = try args.requireString("to")
    switch await languageStatusName(from, to) {
    case "installed": break
    case "supported": throw HelperError("NOT_INSTALLED", "translation languages \(from)→\(to) are not downloaded")
    default: throw HelperError("UNSUPPORTED_PAIR", "cannot translate \(from)→\(to)")
    }
    let session = TranslationSession(installedSource: Locale.Language(identifier: from), target: Locale.Language(identifier: to))
    let requests = texts.enumerated()
        .filter { !$0.element.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        .map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
    var out = texts
    if !requests.isEmpty {
        for response in try await session.translations(from: requests) {
            if let i = response.clientIdentifier.flatMap(Int.init), i < out.count { out[i] = response.targetText }
        }
    }
    return ["texts": out]
}

// ---- Downloading languages ---------------------------------------------------------
//
// Only a SwiftUI `.translationTask` session can ask macOS to download languages: the system
// then shows its own confirmation sheet on our window. Runs as a separate, short-lived
// process: `kadr-helper --prepare-translation <from> <to> <title> <message>`.

@available(macOS 15.0, *)
private struct PrepareTranslationView: View {
    let configuration: TranslationSession.Configuration
    let message: String

    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.small)
            Text(message).multilineTextAlignment(.center).font(.system(size: 13))
        }
        .padding(24)
        .frame(width: 380, height: 140)
        .translationTask(configuration) { session in
            do {
                try await session.prepareTranslation()
                FileHandle.standardOutput.write(Data("{\"ok\":true}\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardOutput.write(Data("{\"ok\":false}\n".utf8))
                exit(1)
            }
        }
    }
}

private final class PrepareWindowDelegate: NSObject, NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        FileHandle.standardOutput.write(Data("{\"ok\":false}\n".utf8))
        exit(2)
    }
}

func runPrepareTranslation(arguments: [String]) -> Never {
    guard #available(macOS 15.0, *), arguments.count >= 2 else { exit(3) }
    let from = arguments[0]
    let to = arguments[1]
    let title = arguments.count > 2 ? arguments[2] : "Kadr"
    let message = arguments.count > 3 ? arguments[3] : "Downloading translation languages…"
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let configuration = TranslationSession.Configuration(source: Locale.Language(identifier: from), target: Locale.Language(identifier: to))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 140), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let delegate = PrepareWindowDelegate()
    window.delegate = delegate
    window.title = title
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: PrepareTranslationView(configuration: configuration, message: message))
    window.center()
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    withExtendedLifetime(delegate) { app.run() }
    exit(0)
}
