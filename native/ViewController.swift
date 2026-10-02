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
    private var launchView: NSView?
    private var launchLabel: NSTextField?
    private var dashboardURL: URL?
    private var busy = false
    private var pageGeneration = 0
    private let worker = FileWorker()
    private let fileQueue = DispatchQueue(label: "macwipe.files", qos: .userInitiated)

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
        showLaunchState("Opening macwipe…")
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
        view.addSubview(browser, positioned: .below, relativeTo: launchView)
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
        showLaunchState("Couldn’t open macwipe. The dashboard is missing.")
    }

    private func showLaunchState(_ message: String) {
        if let launchView {
            launchLabel?.stringValue = message
            launchView.isHidden = false
            return
        }
        let panel = NSView(frame: view.bounds)
        panel.autoresizingMask = [.width, .height]
        panel.wantsLayer = true
        panel.layer?.backgroundColor = NSColor(
            calibratedRed: 1, green: 247 / 255, blue: 237 / 255, alpha: 1
        ).cgColor
        let logo = NSImageView()
        if let url = Bundle.main.url(forResource: "macwipe-icon", withExtension: "png") {
            logo.image = NSImage(contentsOf: url)
        }
        logo.imageScaling = .scaleProportionallyUpOrDown
        logo.setAccessibilityLabel("macwipe")
        let label = NSTextField(wrappingLabelWithString: message)
        label.font = .systemFont(ofSize: 18, weight: .medium)
        label.textColor = NSColor(
            calibratedRed: 80 / 255, green: 45 / 255, blue: 67 / 255, alpha: 1
        )
        label.alignment = .center
        let stack = NSStackView(views: [logo, label])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 128),
            logo.heightAnchor.constraint(equalToConstant: 128),
            stack.centerXAnchor.constraint(equalTo: panel.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: panel.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: panel.widthAnchor, constant: -32)
        ])
        launchView = panel
        launchLabel = label
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
        showLaunchState("Opening macwipe…")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // dashboard.js requests the initial scan after registering callbacks.
        if isDashboard(webView.url) { launchView?.isHidden = true }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showLaunchState("Couldn’t open macwipe. Please reopen the app.")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLaunchState("Couldn’t open macwipe. Please reopen the app.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showLaunchState("macwipe’s dashboard stopped. Please reopen the app.")
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "macwipeBridge", message.frameInfo.isMainFrame,
              isDashboard(message.frameInfo.request.url),
              isDashboard(webView?.url),
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        guard !busy else {
            if action == "requestScan" { return }
            send("onNativeError", BridgeError(action: action, message: "An operation is already running."))
            return
        }
        switch action {
        case "setKept":
            guard body.count == 3, let id = body["id"] as? String, let kept = body["kept"] as? Bool else { return }
            busy = true
            let worker = worker
            fileQueue.async { [weak self] in
                do {
                    try worker.setKept(id: id, kept: kept)
                    let result = worker.scan()
                    DispatchQueue.main.async { [weak self] in
                        self?.busy = false
                        self?.send("receiveScanData", result)
                    }
                } catch {
                    DispatchQueue.main.async { [weak self] in
                        self?.busy = false
                        self?.send("onNativeError", BridgeError(action: action, message: "This item changed. Scan again before changing its exclusion."))
                    }
                }
            }
        case "showInFinder":
            guard body.count == 2, let id = body["id"] as? String else { return }
            busy = true
            let worker = worker
            fileQueue.async { [weak self] in
                let url = try? worker.inventoryURL(id: id)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.busy = false
                    if let url {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                        self.send("onActionComplete", BridgeError(action: action, message: "Revealed in Finder."))
                    } else {
                        self.send("onNativeError", BridgeError(action: action, message: "This item changed or is no longer in the current inventory. Scan again."))
                    }
                }
            }
        case "openLoginItems", "openStorageSettings":
            guard body.count == 1 else { return }
            let login = action == "openLoginItems"
            let destination = login ? "com.apple.LoginItems-Settings.extension" : "com.apple.settings.Storage"
            let opened = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:\(destination)")!)
            send("onActionComplete", BridgeError(action: action, message: opened ? "Opened System Settings."
                : login ? "Open System Settings → General → Login Items."
                : "Open System Settings → General → Storage."))
        case "requestScan":
            requestScan()
        case "removeApplication":
            guard body.count == 1 else {
                send("onNativeError", BridgeError(action: action, message: "Invalid application removal request."))
                return
            }
            removeApplication()
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

    private func removeApplication() {
        let wasBusy = busy
        busy = true
        do {
            try AppRemoval.perform(bundleURL: Bundle.main.bundleURL,
                executableURL: Bundle.main.executableURL, busy: wasBusy,
                trash: { try FileManager.default.trashItem(at: $0, resultingItemURL: nil) },
                quit: { NSApplication.shared.terminate(nil) })
        } catch {
            busy = false
            send("onNativeError", BridgeError(action: "removeApplication", message: error.localizedDescription))
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
    case applications, startup, performance, privacy
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

private enum AppRemoval {
    private enum Failure: String, LocalizedError {
        case busy = "An operation is already running."
        case invalid = "This is not a supported running macwipe app bundle."
        case readOnly = "The app or its location is read-only."
        var errorDescription: String? { rawValue }
    }

    static func perform(bundleURL: URL, executableURL: URL?, busy: Bool,
                        trash: (URL) throws -> Void, quit: () -> Void) throws {
        guard !busy else { throw Failure.busy }
        let target = bundleURL.standardizedFileURL
        let manager = FileManager.default
        guard target.isFileURL, target.pathExtension.lowercased() == "app",
              target.resolvingSymlinksInPath() == target,
              !target.pathComponents.contains(".Trash"),
              let bundle = Bundle(url: target), bundle.bundleIdentifier == "app.macwipe.native",
              bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "macwipe",
              let executableURL, executableURL.standardizedFileURL == bundle.executableURL?.standardizedFileURL,
              executableURL.resolvingSymlinksInPath() == executableURL.standardizedFileURL,
              manager.isExecutableFile(atPath: executableURL.path) else { throw Failure.invalid }
        guard try executableURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true
            else { throw Failure.invalid }
        let values = try target.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .volumeIsReadOnlyKey])
        guard values.isDirectory == true, values.isSymbolicLink == false else { throw Failure.invalid }
        guard values.volumeIsReadOnly == false, manager.isWritableFile(atPath: target.path),
              manager.isWritableFile(atPath: target.deletingLastPathComponent().path) else { throw Failure.readOnly }
        try trash(target)
        quit()
    }
}

private struct ScanItem: Encodable, Sendable {
    let id: String
    let category: String
    let path: String
    let name: String
    let bytes: UInt64
    let formatted: String
    let canClean: Bool
    let kind: String
    let reviewClassification: String
    let bulkSelectionEligible: Bool
    let homeRecommendationEligible: Bool
    let modifiedAt: TimeInterval
    let explanation: String
    let ownerName: String?
    let kept: Bool
}

private struct CategoryScan: Encodable, Sendable {
    var bytes: UInt64 = 0
    var formatted = "0 bytes"
    var eligibleBytes: UInt64 = 0
    var eligibleFormatted = "0 bytes"
    var canClean = false
    var items: [ScanItem] = []
    var skippedPaths = 0
    var error: String?
}

private struct VolumeStorage: Encodable, Sendable {
    let volumeName: String
    let totalBytes: UInt64
    let availableBytes: UInt64
}

private struct ScanData: Encodable, Sendable {
    let categories: [String: CategoryScan]
    let storage: VolumeStorage?
    let staleDownloadDays = 30
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
    private let systemRoot: URL
    private let manager = FileManager.default
    private let trashItem: (URL) throws -> Void
    private let runningApplicationURL: URL
    private var approved: [Category: [String: ApprovedItem]] = [:]
    private var inventory: [String: ApprovedItem] = [:]
    private let preferences: UserDefaults?
    private var keptPaths: Set<String>
    private let staleAge: TimeInterval = 30 * 24 * 60 * 60

    init(home: URL? = nil, systemRoot: URL = URL(fileURLWithPath: "/"),
         runningApplicationURL: URL = Bundle.main.bundleURL,
         preferences: UserDefaults? = nil,
         trashItem: @escaping (URL) throws -> Void = {
             try FileManager.default.trashItem(at: $0, resultingItemURL: nil)
         }) {
        // NSHomeDirectory() may be the app container in a sandboxed app.
        let accountHome = getpwuid(getuid()).flatMap { entry in
            entry.pointee.pw_dir.map { URL(fileURLWithPath: String(cString: $0), isDirectory: true) }
        }
        let candidate = home ?? accountHome ?? manager.homeDirectoryForCurrentUser
        self.home = URL(fileURLWithPath: Self.resolvedPath(candidate) ?? candidate.path,
                        isDirectory: true)
        self.systemRoot = systemRoot
        self.trashItem = trashItem
        self.runningApplicationURL = runningApplicationURL.resolvingSymlinksInPath().standardizedFileURL
        self.preferences = preferences ?? (home == nil ? .standard : nil)
        self.keptPaths = Set((self.preferences?.stringArray(forKey: "macwipe.keptPaths") ?? [])
            .filter { $0.hasPrefix("/") }.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
    }

    func scan(now: Date = Date()) -> ScanData {
        approved.removeAll()
        inventory.removeAll()
        var results: [String: CategoryScan] = [:]
        let applications = roots(for: .applications).prefix(2).flatMap { applicationURLs(in: $0) }
        var installedNames = Set<String>()
        for app in applications {
            installedNames.insert(app.deletingPathExtension().lastPathComponent.lowercased())
            if let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
               let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
               let info = plist as? [String: Any],
               let identifier = info["CFBundleIdentifier"] as? String {
                installedNames.insert(identifier.lowercased())
                let components = identifier.lowercased().split(separator: ".")
                if components.count > 2 { installedNames.insert(String(components[1])) }
                if let name = info["CFBundleName"] as? String {
                    installedNames.insert(name.lowercased())
                }
            }
        }
        for category in Category.allCases {
            var result = CategoryScan()
            for root in roots(for: category) {
                // Invalid or inaccessible roots never disable other roots/items.
                guard (try? validateRoot(root)) != nil else {
                    result.skippedPaths += 1
                    continue
                }
                let entries = category == .applications && root.lastPathComponent != "Application Support"
                    ? applications.filter { $0.path.hasPrefix(root.path + "/") }
                    : children(of: root, onError: { result.skippedPaths += 1 })
                let candidates = category == .caches ? entries.flatMap { entry in
                    // Recognize only specific pip cache units, never the whole tree.
                    entry.lastPathComponent == "pip" && (try? stamp(entry).kind) == S_IFDIR
                        ? children(of: entry, onError: { result.skippedPaths += 1 }) : [entry]
                } : entries
                for child in candidates {
                    // Diagnostic reports have their own Performance inventory.
                    if category == .logs && child.lastPathComponent == "DiagnosticReports" { continue }
                    if category == .applications {
                        if root.lastPathComponent == "Application Support" {
                            guard !installedNames.contains(child.lastPathComponent.lowercased()) else { continue }
                        } else if child.pathExtension.lowercased() != "app" {
                            continue
                        }
                    }
                    if category == .startup && child.pathExtension.lowercased() != "plist" { continue }
                    if category == .privacy && !isBrowsingTrace(child, root: root) { continue }
                    scanEntry(child, root: root, category: category, now: now, result: &result)
                }
            }
            result.formatted = format(result.bytes)
            result.eligibleFormatted = format(result.eligibleBytes)
            result.canClean = result.items.contains { $0.canClean }
            result.items.sort { $0.path < $1.path }
            results[category.rawValue] = result
        }
        // Storage is an overview; items retain their original cleanup category.
        var storage = CategoryScan()
        for category in [Category.caches, .logs, .trash, .downloads] {
            if let scan = results[category.rawValue] {
                storage.bytes += scan.bytes
                storage.eligibleBytes += scan.eligibleBytes
                storage.items.append(contentsOf: scan.items)
            }
        }
        storage.formatted = format(storage.bytes)
        storage.eligibleFormatted = format(storage.eligibleBytes)
        storage.canClean = storage.items.contains { $0.canClean }
        results["storage"] = storage
        return ScanData(categories: results, storage: volumeStorage())
    }

    private func volumeStorage() -> VolumeStorage? {
        // A fresh URL avoids reusing capacity values cached by a prior scan.
        let location = URL(fileURLWithPath: home.path, isDirectory: true)
        guard let values = try? location.resourceValues(forKeys: [
            .volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey
        ]), let name = values.volumeName, !name.isEmpty,
           let total = values.volumeTotalCapacity, total > 0,
           let available = values.volumeAvailableCapacity,
           available >= 0, available <= total else { return nil }
        return VolumeStorage(volumeName: name, totalBytes: UInt64(total),
                             availableBytes: UInt64(available))
    }

    private func roots(for category: Category) -> [URL] {
        func local(_ path: String) -> URL { home.appendingPathComponent(path, isDirectory: true) }
        func system(_ path: String) -> URL {
            let candidate = systemRoot.appendingPathComponent(path, isDirectory: true)
            // /var is a standard macOS alias for /private/var.
            return URL(fileURLWithPath: Self.resolvedPath(candidate) ?? candidate.path, isDirectory: true)
        }
        switch category {
        case .caches: return [local("Library/Caches")]
        case .logs: return [local("Library/Logs")]
        case .trash: return [local(".Trash")]
        case .downloads: return [local("Downloads")]
        case .applications:
            return [system("Applications"), local("Applications"), local("Library/Application Support")]
        case .startup:
            return [local("Library/LaunchAgents"), system("Library/LaunchAgents"), system("Library/LaunchDaemons")]
        case .performance:
            return [system("var/log"), local("Library/Logs/DiagnosticReports")]
        case .privacy:
            var paths = [local("Library/Safari"), local("Library/Cookies"),
                         local("Library/Containers/com.apple.Safari/Data/Library/Safari"),
                         local("Library/Containers/com.apple.Safari/Data/Library/Cookies")]
            let chrome = local("Library/Application Support/Google/Chrome")
            for profile in children(of: chrome) where profile.lastPathComponent == "Default"
                || profile.lastPathComponent.hasPrefix("Profile ") {
                paths.append(profile)
                paths.append(profile.appendingPathComponent("Network", isDirectory: true))
            }
            return paths
        }
    }

    private func children(of root: URL, onError: () -> Void = {}) -> [URL] {
        do {
            try validateRoot(root)
            return try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        } catch {
            onError()
            return []
        }
    }

    private func applicationURLs(in root: URL) -> [URL] {
        guard (try? validateRoot(root)) != nil,
              let enumerator = manager.enumerator(at: root,
                  includingPropertiesForKeys: nil,
                  options: [.skipsPackageDescendants],
                  errorHandler: { _, _ in true }) else { return [] }
        var applications: [URL] = []
        for case let url as URL in enumerator {
            guard let metadata = try? stamp(url) else { continue }
            if metadata.kind == S_IFLNK {
                enumerator.skipDescendants()
                continue
            }
            if metadata.kind == S_IFDIR && url.pathExtension.lowercased() == "app" {
                applications.append(url)
                enumerator.skipDescendants()
            }
        }
        return applications
    }

    private func isBrowsingTrace(_ file: URL, root: URL) -> Bool {
        let name = file.lastPathComponent
        if root.lastPathComponent == "Cookies" { return name.hasSuffix(".binarycookies") }
        let names: Set<String> = ["History", "Cookies", "History.db", "History.plist",
                                  "LastSession.plist", "RecentlyClosedTabs.plist", "WebpageIcons.db",
                                  "Favicon Cache", "LocalStorage", "Databases"]
        return names.contains(name) || names.contains(name.replacingOccurrences(of: "-wal", with: ""))
            || names.contains(name.replacingOccurrences(of: "-shm", with: ""))
            || names.contains(name.replacingOccurrences(of: "-journal", with: ""))
    }

    private func scanEntry(_ url: URL, root: URL, category: Category,
                           now: Date, result: inout CategoryScan) {
        guard !containsRunningApplication(url) else { return }
        do {
            let measured = try measure(url)
            guard let metadata = measured.entries[url.path] else { return }
            let nextBytes = try adding(result.bytes, measured.bytes)
            let eligible = category != .trash && metadata.kind != S_IFLNK
                && (category != .downloads || eligibleDownload(metadata, url: url, root: root, now: now))
            if eligible {
                // Performance inventories resolved system logs and user diagnostic reports.
                // Neither these locations nor startup configurations have cleanup eligibility.
                let kept = isKept(url)
                let canClean = category != .startup && category != .performance && !kept
                if canClean {
                    result.eligibleBytes = try adding(result.eligibleBytes, measured.bytes)
                    approved[category, default: [:]][url.path] = ApprovedItem(root: root, category: category, measured: measured)
                }
                let unmatched = category == .applications && root.lastPathComponent == "Application Support"
                let cacheRule = category == .caches ? recognizedCache(url, root: root) : nil
                let kind: String
                switch category {
                case .caches: kind = "cache"
                case .downloads: kind = "older-download"
                case .applications: kind = unmatched ? "unmatched-support" : "application"
                case .startup: kind = "startup-file"
                case .logs, .performance: kind = "log"
                case .privacy: kind = "browser-data"
                case .trash: kind = "trash-item"
                }
                inventory["\(category.rawValue):\(url.path)"] = ApprovedItem(root: root, category: category, measured: measured)
                result.items.append(ScanItem(id: "\(category.rawValue):\(url.path)",
                    category: category.rawValue, path: url.path,
                    name: unmatched ? "Unmatched support · \(url.lastPathComponent)" : url.lastPathComponent,
                    bytes: measured.bytes, formatted: format(measured.bytes), canClean: canClean,
                    kind: kind,
                    reviewClassification: cacheRule != nil ? "temporary" : "review-carefully",
                    bulkSelectionEligible: canClean && cacheRule != nil,
                    homeRecommendationEligible: canClean && (cacheRule != nil || category == .downloads),
                    modifiedAt: Double(metadata.modifiedSeconds) + Double(metadata.modifiedNanoseconds) / 1_000_000_000,
                    explanation: cacheRule?.explanation ?? (category == .caches
                        ? "Unrecognized cache candidate. Review individually; its contents and removal consequences are not established. Folder modification time is not the age of every child."
                        : ""), ownerName: cacheRule?.owner, kept: kept))
            }
            result.bytes = nextBytes
        } catch {
            // A restricted descendant must not hide accessible siblings. Never
            // approve a partial directory or a damaged/partly unreadable app.
            result.skippedPaths += 1
            guard category != .downloads, url.pathExtension.lowercased() != "app" else { return }
            for child in children(of: url) {
                scanEntry(child, root: root, category: category, now: now, result: &result)
            }
        }
    }

    private func isKept(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        return keptPaths.contains { path == $0 || path.hasPrefix($0 + "/") || $0.hasPrefix(path + "/") }
    }

    func setKept(id: String, kept: Bool) throws {
        let path = try inventoryURL(id: id).standardizedFileURL.path
        if kept { keptPaths.insert(path) }
        else { keptPaths = keptPaths.filter { path != $0 && !path.hasPrefix($0 + "/") && !$0.hasPrefix(path + "/") } }
        preferences?.set(keptPaths.sorted(), forKey: "macwipe.keptPaths")
    }

    func inventoryURL(id: String) throws -> URL {
        guard let item = inventory[id] else { throw FileSafetyError.changed }
        try validateRoot(item.root)
        let url = item.measured.url
        guard url.path.hasPrefix(item.root.path + "/"), Self.resolvedPath(url) == url.path,
              try measure(url).entries == item.measured.entries else { throw FileSafetyError.changed }
        return url
    }

    func cleanup(_ selections: [CleanupSelection], now: Date = Date()) -> CleanupResult {
        var result = CleanupResult()
        // Consume the approval once, including failed attempts.
        let snapshot = approved
        approved.removeAll()
        var targets: [ApprovedItem] = []
        var selectedPaths = Set<String>()
        for selection in selections {
            guard let category = Category(rawValue: selection.id), category != .trash,
                  category != .startup, category != .performance,
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
                targets.append(items[path]!)
            }
        }

        // Selecting a folder and one of its descendants moves the folder once.
        let topLevelTargets = targets.filter { candidate in
            !targets.contains { other in
                candidate.measured.url.path.hasPrefix(other.measured.url.path + "/")
            }
        }
        for target in topLevelTargets.sorted(by: { $0.measured.url.path < $1.measured.url.path }) {
            do {
                let root = target.root
                let item = target.measured
                guard !containsRunningApplication(item.url), !isKept(item.url) else { throw FileSafetyError.changed }
                try validateRoot(root)
                guard item.url.path.hasPrefix(root.path + "/"),
                      Self.resolvedPath(item.url) == item.url.path else {
                    throw FileSafetyError.changed
                }
                // Compare every entry; do not trash a directory changed since review.
                let current = try measure(item.url)
                guard current.entries == item.entries else { throw FileSafetyError.changed }
                if target.category == .downloads {
                    guard let metadata = current.entries[item.url.path],
                          eligibleDownload(metadata, url: item.url, root: root, now: now) else { throw FileSafetyError.changed }
                }
                let nextBytes = try adding(result.movedBytes, current.bytes)
                // The sole mutation API. No permanent deletion or fallback.
                try trashItem(item.url)
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

    private func containsRunningApplication(_ url: URL) -> Bool {
        guard runningApplicationURL.pathExtension.lowercased() == "app" else { return false }
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        let running = runningApplicationURL.path
        return path == running || path.hasPrefix(running + "/") || running.hasPrefix(path + "/")
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

    private struct ApprovedItem {
        let root: URL
        let category: Category
        let measured: MeasuredItem
    }

    private struct CacheRule {
        let relativePath: String
        let owner: String
        let explanation: String
    }

    private func recognizedCache(_ url: URL, root: URL) -> CacheRule? {
        let rules = [
            CacheRule(relativePath: "pip/http-v2", owner: "pip", explanation: "Recognized pip HTTP response cache. Removal may require downloading responses again. Folder modification time is not the age of every child."),
            CacheRule(relativePath: "pip/wheels", owner: "pip", explanation: "Recognized pip wheel cache. Removal may require rebuilding or downloading wheels again. Folder modification time is not the age of every child.")
        ]
        return rules.first { root.appendingPathComponent($0.relativePath).path == url.path
            && (try? stamp(url).kind) == S_IFDIR }
    }

    private func eligibleDownload(_ metadata: FileStamp, url: URL, root: URL, now: Date) -> Bool {
        let modified = Double(metadata.modifiedSeconds) + Double(metadata.modifiedNanoseconds) / 1_000_000_000
        return metadata.kind == S_IFREG && url.deletingLastPathComponent().path == root.path
            && modified < now.timeIntervalSince1970 - staleAge
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
