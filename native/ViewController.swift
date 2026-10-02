import AppKit
import WebKit
import Darwin

// macOS 13+. Add Web as a folder resource containing dashboard.html,
// macwipe-bridge.js, and its local styles/scripts/assets. No third-party code.
// Intended for a non-sandboxed Cocoa target; filesystem/TCC permissions apply.
// Set NSDownloadsFolderUsageDescription in the target's Info.plist.
@MainActor
final class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private var webView: WKWebView?
    private var dashboardURL: URL?
    private var busy = false
    private var pageGeneration = 0
    private let worker = FileWorker()
    private let fileQueue = DispatchQueue(label: "macwipe.files", qos: .userInitiated)

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // WKUserContentController retains its handler; the proxy breaks the cycle.
        configuration.userContentController.add(
            WeakMessageHandler(self), name: "macwipeBridge"
        )
        let browser = WKWebView(frame: view.bounds, configuration: configuration)
        browser.autoresizingMask = [.width, .height]
        browser.navigationDelegate = self
        view.addSubview(browser)
        webView = browser
        loadDashboard()
    }

    private func loadDashboard() {
        guard let webView else { return }
        let candidates = [
            Bundle.main.url(forResource: "dashboard", withExtension: "html", subdirectory: "Web"),
            Bundle.main.url(forResource: "dashboard", withExtension: "html"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("Web/dashboard.html")
        ]
        for case let url? in candidates {
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let webFolder = url.deletingLastPathComponent()
            let bridge = webFolder.appendingPathComponent("macwipe-bridge.js")
            dashboardURL = url.resolvingSymlinksInPath().standardizedFileURL
            let configuration = webView.configuration
            if let source = try? String(contentsOf: bridge, encoding: .utf8) {
                configuration.userContentController.addUserScript(WKUserScript(
                    source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true
                ))
            } else {
                NSLog("macwipe: macwipe-bridge.js could not be loaded.")
            }
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        }
        webView.loadHTMLString("<body style='background:#1a1a1a;color:#fff;font-family:sans-serif;padding:20px;'>Missing Web/dashboard.html or Web/macwipe-bridge.js in the app bundle.</body>", baseURL: nil)
    }

    private func showSetupError() {
        let label = NSTextField(wrappingLabelWithString:
            "Missing dashboard.html in bundled Web/, app resources, or the working directory's Web/."
        )
        label.frame = view.bounds.insetBy(dx: 24, dy: 24)
        label.autoresizingMask = [.width, .height]
        view.addSubview(label)
    }

    private func isDashboard(_ url: URL?) -> Bool {
        guard let url, url.isFileURL, let dashboardURL else { return false }
        return url.resolvingSymlinksInPath().standardizedFileURL.path == dashboardURL.path
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // Only the bundled dashboard can navigate or invoke native operations.
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true
            && isDashboard(navigationAction.request.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageGeneration += 1
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if isDashboard(webView.url), !busy { requestScan() }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "macwipeBridge", message.frameInfo.isMainFrame,
              isDashboard(message.frameInfo.request.url),
              isDashboard(webView?.url),
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        guard !busy else {
            send("onNativeError", BridgeError(action: action, message: "An operation is already running."))
            return
        }
        switch action {
        case "requestScan":
            requestScan()
        case "keepFiles":
            // Do not enumerate, alter, or trash any file for this action.
            NSLog("macwipe: user chose Keep Files.")
            webView?.evaluateJavaScript("window.macwipeUI.onKeepConfirmed()", completionHandler: nil)
        case "deleteFiles":
            guard let categories = body["categories"],
                  JSONSerialization.isValidJSONObject(categories),
                  let data = try? JSONSerialization.data(withJSONObject: categories),
                  let selections = try? JSONDecoder().decode([CleanupSelection].self, from: data),
                  !selections.isEmpty, selections.count <= Category.allCases.count else {
                send("onNativeError", BridgeError(action: action, message: "Select valid scan categories first."))
                return
            }
            deleteFiles(selections)
        default:
            send("onNativeError", BridgeError(action: action, message: "Unknown bridge action."))
        }
    }

    private func requestScan() {
        busy = true
        let generation = pageGeneration
        let worker = worker
        fileQueue.async { [weak self] in
            let result = worker.scan()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.busy = false
                guard generation == self.pageGeneration else {
                    if self.isDashboard(self.webView?.url) { self.requestScan() }
                    return
                }
                self.send("receiveScanData", result)
            }
        }
    }

    private func deleteFiles(_ selections: [CleanupSelection]) {
        busy = true
        let generation = pageGeneration
        let worker = worker
        fileQueue.async { [weak self] in
            let result = worker.cleanup(selections)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.busy = false
                if generation == self.pageGeneration, let json = self.json(result) {
                    // Compatibility name: this is MB moved, NOT disk space freed.
                    let movedMB = Double(result.movedBytes) / 1_000_000
                    self.webView?.evaluateJavaScript(
                        "window.macwipeUI.onCleanupComplete(\(movedMB),\(json))",
                        completionHandler: nil
                    )
                }
                if self.isDashboard(self.webView?.url) { self.requestScan() }
            }
        }
    }

    private func json<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func send<T: Encodable>(_ method: String, _ value: T) {
        guard isDashboard(webView?.url), let payload = json(value) else { return }
        webView?.evaluateJavaScript("window.macwipeUI.\(method)(\(payload))") { _, error in
            if error != nil { NSLog("macwipe: JavaScript callback failed.") }
        }
    }
}

@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: ViewController?
    init(_ target: ViewController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

private enum Category: String, CaseIterable, Sendable {
    case caches, logs, trash, downloads
    var relativePath: String {
        switch self {
        case .caches: return "Library/Caches"
        case .logs: return "Library/Logs"
        case .trash: return ".Trash"
        case .downloads: return "Downloads"
        }
    }
}

private struct CleanupSelection: Decodable, Sendable {
    let id: String
    let paths: [String]?
    private enum CodingKeys: String, CodingKey { case id, paths }
    init(from decoder: Decoder) throws {
        if let id = try? decoder.singleValueContainer().decode(String.self) {
            self.id = id
            paths = nil
        } else {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            paths = try values.decodeIfPresent([String].self, forKey: .paths)
        }
    }
}

private struct BridgeError: Encodable, Sendable {
    let action: String
    let message: String
}

private struct ScanItem: Encodable, Sendable {
    let path: String
    let name: String
    let bytes: UInt64
    let formatted: String
}

private struct CategoryScan: Encodable, Sendable {
    var bytes: UInt64 = 0
    var formatted = "0 bytes"
    var eligibleBytes: UInt64 = 0
    var eligibleFormatted = "0 bytes"
    var canClean = false
    var items: [ScanItem] = []
    var error: String?
}

private struct ScanData: Encodable, Sendable {
    let categories: [String: CategoryScan]
    let staleDownloadDays = 90
    let sizeMeaning = "Logical file bytes; not allocated or reclaimable disk space."
}

private struct CleanupResult: Encodable, Sendable {
    var movedBytes: UInt64 = 0
    var movedCount = 0
    var errors: [String] = []
    let diskFreedMB = 0
}

// Confined to fileQueue. Sendable only permits passing its reference to that queue.
private final class FileWorker: @unchecked Sendable {
    private let home: URL
    private let manager = FileManager.default
    private var approved: [Category: [String: MeasuredItem]] = [:]
    private let staleAge: TimeInterval = 90 * 24 * 60 * 60

    init(home: URL? = nil) {
        // NSHomeDirectory() may be the app container in a sandboxed app.
        let accountHome = getpwuid(getuid()).flatMap { entry in
            entry.pointee.pw_dir.map { URL(fileURLWithPath: String(cString: $0), isDirectory: true) }
        }
        let candidate = home ?? accountHome ?? manager.homeDirectoryForCurrentUser
        self.home = URL(fileURLWithPath: Self.resolvedPath(candidate) ?? candidate.path,
                        isDirectory: true)
    }

    func scan(now: Date = Date()) -> ScanData {
        approved.removeAll()
        var results: [String: CategoryScan] = [:]
        for category in Category.allCases {
            var result = CategoryScan()
            let root = home.appendingPathComponent(category.relativePath, isDirectory: true)
            do {
                try validateRoot(root)
                let children = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                for child in children {
                    do {
                        let measured = try measure(child)
                        result.bytes = try adding(result.bytes, measured.bytes)
                        let stamp = measured.entries[child.path]!
                        // Never empty Trash; Downloads folders/recent files are kept.
                        let eligible = category != .trash && stamp.kind != S_IFLNK
                            && (category != .downloads || (stamp.kind == S_IFREG
                                && Double(stamp.modifiedSeconds) < now.timeIntervalSince1970 - staleAge))
                        if eligible {
                            approved[category, default: [:]][child.path] = measured
                            result.eligibleBytes = try adding(result.eligibleBytes, measured.bytes)
                            result.items.append(ScanItem(path: child.path, name: child.lastPathComponent,
                                bytes: measured.bytes, formatted: format(measured.bytes)))
                        }
                    } catch {
                        result.error = "Scan incomplete: some items could not be read. Cleanup disabled."
                    }
                }
                if result.error != nil {
                    approved[category] = nil
                    result.items = []
                    result.eligibleBytes = 0
                }
            } catch {
                result.error = "Directory unavailable, redirected, or access denied."
                approved[category] = nil
            }
            result.formatted = format(result.bytes)
            result.eligibleFormatted = format(result.eligibleBytes)
            result.canClean = !result.items.isEmpty && result.error == nil
            result.items.sort { $0.path < $1.path }
            results[category.rawValue] = result
        }
        return ScanData(categories: results)
    }

    func cleanup(_ selections: [CleanupSelection]) -> CleanupResult {
        var result = CleanupResult()
        // Consume the approval once, including failed attempts.
        let snapshot = approved
        approved.removeAll()
        var targets: [(Category, MeasuredItem)] = []
        var selectedPaths = Set<String>()
        for selection in selections {
            guard let category = Category(rawValue: selection.id), category != .trash,
                  let items = snapshot[category] else {
                result.errors.append("Category is unavailable or cannot be cleaned. Scan again.")
                return result
            }
            let paths = selection.paths ?? Array(items.keys)
            guard !paths.isEmpty, paths.count <= items.count,
                  paths.allSatisfy({ items[$0] != nil }) else {
                result.errors.append("A requested path was not approved by the last scan.")
                return result
            }
            for path in paths where selectedPaths.insert(path).inserted {
                targets.append((category, items[path]!))
            }
        }

        for (category, item) in targets.sorted(by: { $0.1.url.path < $1.1.url.path }) {
            do {
                let root = home.appendingPathComponent(category.relativePath, isDirectory: true)
                try validateRoot(root)
                guard item.url.deletingLastPathComponent().path == root.path,
                      Self.resolvedPath(item.url) == item.url.path else {
                    throw FileSafetyError.changed
                }
                // Compare every entry; do not trash a directory changed since review.
                let current = try measure(item.url)
                guard current.entries == item.entries else { throw FileSafetyError.changed }
                let nextBytes = try adding(result.movedBytes, current.bytes)
                // The sole mutation API. No permanent deletion or fallback.
                try FileManager.default.trashItem(at: item.url, resultingItemURL: nil)
                result.movedBytes = nextBytes
                result.movedCount += 1
            } catch {
                result.errors.append("An item changed, became unreadable, or could not be moved to Trash. Scan again.")
            }
        }
        return result
    }

    private func validateRoot(_ root: URL) throws {
        guard Self.resolvedPath(root) == root.path,
              try stamp(root).kind == S_IFDIR else { throw FileSafetyError.changed }
    }

    private static func resolvedPath(_ url: URL) -> String? {
        // Foundation may abbreviate /private/var to /var for directory URLs.
        // realpath gives consistent filesystem paths for safety comparisons.
        url.withUnsafeFileSystemRepresentation { path in
            guard let path, let resolved = realpath(path, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        }
    }

    private struct FileStamp: Equatable {
        let device: dev_t
        let inode: ino_t
        let kind: mode_t
        let size: Int64
        let modifiedSeconds: Int
        let modifiedNanoseconds: Int
        let changedSeconds: Int
        let changedNanoseconds: Int
    }

    private struct MeasuredItem {
        let url: URL
        let bytes: UInt64
        let entries: [String: FileStamp]
    }

    private func stamp(_ url: URL) throws -> FileStamp {
        var info = stat()
        let status = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return lstat(path, &info)
        }
        guard status == 0 else { throw FileSafetyError.unreadable }
        return FileStamp(device: info.st_dev, inode: info.st_ino, kind: info.st_mode & S_IFMT,
            size: info.st_size, modifiedSeconds: info.st_mtimespec.tv_sec,
            modifiedNanoseconds: info.st_mtimespec.tv_nsec, changedSeconds: info.st_ctimespec.tv_sec,
            changedNanoseconds: info.st_ctimespec.tv_nsec)
    }

    private func measure(_ url: URL) throws -> MeasuredItem {
        var bytes: UInt64 = 0
        var entries: [String: FileStamp] = [:]
        var pending = [url]
        while let entry = pending.popLast() {
            let metadata = try stamp(entry)
            entries[entry.path] = metadata
            switch metadata.kind {
            case S_IFDIR:
                // Reject directory symlinks/redirects, including ancestors.
                guard Self.resolvedPath(entry) == entry.path else {
                    throw FileSafetyError.changed
                }
                pending.append(contentsOf: try manager.contentsOfDirectory(
                    at: entry, includingPropertiesForKeys: nil
                ))
                guard try stamp(entry) == metadata else { throw FileSafetyError.changed }
            case S_IFREG, S_IFLNK:
                // Count a link's own bytes without following it. Include hidden files.
                guard metadata.size >= 0 else { throw FileSafetyError.unreadable }
                bytes = try adding(bytes, UInt64(metadata.size))
            default:
                throw FileSafetyError.unreadable
            }
        }
        return MeasuredItem(url: url, bytes: bytes, entries: entries)
    }

    private func adding(_ lhs: UInt64, _ rhs: UInt64) throws -> UInt64 {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        guard !overflow else { throw FileSafetyError.unreadable }
        return sum
    }

    private func format(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(clamping: bytes), countStyle: .decimal)
    }
}

private enum FileSafetyError: Error { case unreadable, changed }
