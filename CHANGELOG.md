# Kadr changelog

## 1.0.16, 22 November 2026

- This is the first public release. The source code uses the MIT License.
- This release includes a free build of FFmpeg 8.1.3 compiled from source without `--enable-nonfree`. The app includes the FFmpeg licenses and build configuration. The release includes the source archives.
- The Windows release comes as an MSI installer and a ZIP archive.
- The app includes the MIT License and third-party notices. The installers omit tests, documentation, and utility scripts.
- The macOS builds use ad hoc signing. After an update, macOS may ask for screen recording permission again.

## 1.0.15, 20 November 2026

- In region selection, click a highlighted window to capture it with its tooltips and context menus. Kadr crops the window from a frozen frame and extends the selection to include same-app pop-ups outside the window. The highlight shows the area Kadr will capture.
- Window mode still captures an ordinary window with its shadow and transparency. If a menu or tooltip is open over it, Kadr uses the frozen frame.
- The macOS builds use a persistent signing key. macOS will keep screen recording permission across subsequent updates. If you switch from an ad hoc build, grant permission once more.

## 1.0.14, 20 November 2026

- On macOS, region capture, window capture, text recognition, translation, and the color picker now include tooltips, hover highlights, pop-up panels, and open menus. Kadr captures the screen before it shows the selection overlay. The overlay appears about 150 ms later.
- If an editor tries to save an older revision of a library image, Kadr saves a separate copy and keeps the original.
- The editor asks before closing a capture or library item with unsaved changes. A second close request during a save does not start another save.
- Resetting settings applies the defaults for keyboard shortcuts, the tray icon, and launch at login immediately.
- If fallback capture with `screencapture` fails on one display, Kadr deletes frames it already saved from other displays.
- Electron now uses version 44.11.5. GitHub Actions now use Node 24.

## 1.0.13, 12 November 2026

- On macOS, capture preparation refreshes the list of windows and displays without taking a test screenshot. This prevents the test screenshot from overlapping the requested capture.
- On macOS 26 and later, the helper uses the ScreenCaptureKit single-screenshot API to capture displays.
- If ScreenCaptureKit refuses a capture, the helper checks screen recording permission separately so it can report the cause more accurately.
- A regression test checks consecutive screenshots when preparation and capture start at the same time.

## 1.0.12, 12 November 2026

- Fixed the Windows path tests and the rotated video export test. The video test now sets the rotation matrix through FFmpeg.
- GitHub Actions uses Xcode 26.3 to build the native helper for both macOS architectures.
- This release has macOS builds for Apple Silicon and Intel, plus an installer and a portable build for Windows x64.

## 1.0.11, 12 November 2026

- Hidden areas stay covered in both frames of a before-and-after GIF.
- Concurrent video exports save to separate files and preserve existing copies.
- Copying a capture manually cancels any pending automatic copy of the original.
- Fixed filename collisions during concurrent saves, library recovery after an interrupted index write, and stale thumbnails after a failed edit.
- The editor marks a document as unsaved as soon as you change the backdrop or type. You can save while typing. Text recognition and background removal discard outdated results. Copy and Save run in order. Both GIF frames use the same revision.
- Closing or crashing a capture window releases its session. Scrolling requests time out, and scrolling captures respect the height limit. If a display disappears, Kadr will skip sources with a different known display ID.
- Canceling recording setup releases resources that arrive after cancellation. Fixed rotated video dimensions and races between import, delete, and export. Keyboard shortcuts recover after a settings failure.
- Failed reads or saves preserve the raw recording, separate audio, and the completed intermediate file. Kadr still cleans up after a successful save.
- The editor stops building a selection outline when it reaches the complexity limit.
- Updated Electron within version 44 and updated the build tools. The minimatch fix applies only to vulnerable versions 7 through 10. Dependent tools still use the version 3 and 5 APIs they require.
- Added regression tests and a repeatable editor check with synthetic 1080p and 4K images.

## 1.0.10

This version includes fixes from the project audit and local 1.0.9 changes that had yet to reach Git.

- Clicking the app icon brings an open editor forward or restores a minimized window. Kadr no longer opens settings over an existing document.
- The preloaded editor gets the capture pixels even if its window loads late, before the PNG appears on disk. If an image fails to load, the editor shows an error instead of a blank canvas.
- Save and Copy use a consistent document snapshot and leave newer edits marked as unsaved. The editor discards translation results if the image changes.
- Canceling a video export prevents subsequent file replacement. Kadr runs repeated export jobs in order, keeps the selected audio track, and checks its codec. Audio exports respect disabled sound sources.
- Kadr writes settings, images, and the library index to temporary files before replacing the originals atomically. The index has a backup. Late text recognition results cannot return redacted text to search. When you quit, Kadr finishes writing new captures and the index without waiting for background text recognition. If you cancel quitting, later saves still work.
- The main process restricts interprocess communication by page and to the main frame. File access requires a choice by the user and applies to a specific window. The scrolling capture worker keeps the permission it needs for the video stream.
- Launching or updating Kadr preserves system permissions. Sending recognized text to the online translator requires explicit confirmation.
- The macOS package includes offline text recognition for use when the system service fails.
- Fixed the standard build script for the universal Swift helper.

The checks included `npm test`, `npm run test:electron`, and a local macOS build. The tests use synthetic images and videos in a separate temporary profile. Testing on Windows, capture across multiple physical displays, and system permissions require separate checks.
