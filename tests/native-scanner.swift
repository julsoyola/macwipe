// Concatenated with ViewController.swift by native-tests.py so private scanner
// types remain private in the production app. All paths are temporary fixtures.
private let testManager = FileManager.default
private let nativeTestRoot = testManager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
private let nativeTestHome = nativeTestRoot.appendingPathComponent("home")
private let nativeTestSystem = nativeTestRoot.appendingPathComponent("system")

private func writeFixture(_ path: String, under root: URL, data: Data = Data([1, 2, 3])) throws -> URL {
    let url = root.appendingPathComponent(path)
    try testManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
    return url
}

private func selections(_ entries: [(String, [String])]) throws -> [CleanupSelection] {
    let objects: [[String: Any]] = entries.map { entry in
        ["id": entry.0, "paths": entry.1]
    }
    let data = try JSONSerialization.data(withJSONObject: objects)
    return try JSONDecoder().decode([CleanupSelection].self, from: data)
}

private func runScannerTests() throws {
    let installedInfo = try PropertyListSerialization.data(fromPropertyList: [
        "CFBundleIdentifier": "com.google.Chrome", "CFBundleName": "Google Chrome"
    ], format: .xml, options: 0)
    _ = try writeFixture("Applications/Google Chrome.app/Contents/Info.plist", under: nativeTestSystem, data: installedInfo)
    _ = try writeFixture("Applications/Local.app/Contents/Info.plist", under: nativeTestHome)
    _ = try writeFixture("Applications/Utilities/Nested.app/Contents/Info.plist", under: nativeTestSystem)
    _ = try writeFixture("Library/Application Support/UnknownApp/data", under: nativeTestHome)
    _ = try writeFixture("Library/Application Support/Google/Chrome/Default/History", under: nativeTestHome)
    _ = try writeFixture("Library/Application Support/Google/Chrome/Default/Bookmarks", under: nativeTestHome)
    _ = try writeFixture("Library/Application Support/Google/Chrome/Default/Network/Cookies", under: nativeTestHome)
    let valid = try writeFixture("Library/Caches/valid", under: nativeTestHome)
    _ = try writeFixture("Library/Caches/mixed/readable", under: nativeTestHome)
    _ = try writeFixture("Library/Caches/mixed/locked/private", under: nativeTestHome)
    let locked = nativeTestHome.appendingPathComponent("Library/Caches/mixed/locked")
    try testManager.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
    defer { try? testManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
    _ = try writeFixture("Library/Logs/log", under: nativeTestHome)
    _ = try writeFixture("Library/Logs/DiagnosticReports/crash.ips", under: nativeTestHome)
    _ = try writeFixture(".Trash/kept", under: nativeTestHome)
    let stale = try writeFixture("Downloads/stale.zip", under: nativeTestHome)
    try testManager.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -91 * 86400)], ofItemAtPath: stale.path)
    _ = try writeFixture("Downloads/recent.zip", under: nativeTestHome)
    _ = try writeFixture("Library/LaunchAgents/user.plist", under: nativeTestHome)
    _ = try writeFixture("Library/LaunchAgents/ignore.txt", under: nativeTestHome)
    _ = try writeFixture("Library/LaunchAgents/global.plist", under: nativeTestSystem)
    _ = try writeFixture("Library/LaunchDaemons/daemon.plist", under: nativeTestSystem)
    _ = try writeFixture("var/log/system.log", under: nativeTestSystem)
    _ = try writeFixture("Library/Safari/History.db", under: nativeTestHome)
    _ = try writeFixture("Library/Safari/Bookmarks.plist", under: nativeTestHome)
    _ = try writeFixture("Library/Cookies/Cookies.binarycookies", under: nativeTestHome)
    try testManager.createSymbolicLink(at: nativeTestHome.appendingPathComponent("Library/Caches/link"),
                                     withDestinationURL: stale)

    var moved: [String] = []
    let worker = FileWorker(home: nativeTestHome, systemRoot: nativeTestSystem, trashItem: { moved.append($0.path) })
    let scan = worker.scan()
    let validPath = scan.categories["caches"]!.items.first { $0.name == "valid" }!.path
    let tabs = ["storage", "caches", "downloads", "applications", "startup", "performance", "privacy"]
    for key in tabs {
        let category = scan.categories[key]!
        precondition(category.canClean && category.error == nil && !category.items.isEmpty, key)
        precondition(category.items.allSatisfy { $0.canClean && !$0.id.isEmpty && !$0.category.isEmpty && $0.path.hasPrefix("/") })
    }
    precondition(scan.categories["caches"]!.items.count == 2)
    precondition(scan.categories["downloads"]!.items.map(\.name) == ["stale.zip"])
    precondition(scan.categories["applications"]!.items.count == 4)
    precondition(!scan.categories["applications"]!.items.contains { $0.path.hasSuffix("/Google") })
    precondition(scan.categories["startup"]!.items.count == 3)
    precondition(scan.categories["performance"]!.items.count == 2)
    precondition(scan.categories["privacy"]!.items.count == 4)
    precondition(!scan.categories["privacy"]!.items.contains { $0.name.contains("Bookmarks") })
    precondition(scan.categories["trash"]!.items.isEmpty)
    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scan)) as! [String: Any]
    let volume = try nativeTestHome.resourceValues(forKeys: [.volumeNameKey, .volumeTotalCapacityKey])
    let capacity = scan.storage!
    precondition(capacity.volumeName == volume.volumeName)
    precondition(capacity.totalBytes == UInt64(volume.volumeTotalCapacity!))
    precondition(capacity.availableBytes <= capacity.totalBytes)
    let encodedStorage = encoded["storage"] as! [String: Any]
    precondition(["volumeName", "totalBytes", "availableBytes"].allSatisfy { encodedStorage[$0] != nil })
    precondition(encodedStorage["segments"] == nil)
    let missingHome = nativeTestRoot.appendingPathComponent("missing-home")
    let missingScan = FileWorker(home: missingHome, systemRoot: nativeTestSystem,
                                 trashItem: { _ in }).scan()
    precondition(missingScan.storage == nil)
    let categories = encoded["categories"] as! [String: [String: Any]]
    let item = (categories["applications"]!["items"] as! [[String: Any]])[0]
    precondition(["id", "category", "path", "name", "bytes", "formatted", "canClean"].allSatisfy { item[$0] != nil })

    let all: [(String, [String])] = Category.allCases.filter { $0 != .trash }.map { category in
        (category.rawValue, scan.categories[category.rawValue]!.items.map(\.path))
    }
    let selectedCount = all.reduce(0) { $0 + $1.1.count }
    let result = worker.cleanup(try selections(all))
    precondition(result.errors.isEmpty && result.movedCount == selectedCount)
    precondition(moved.count == Set(moved).count)
    precondition(result.diskFreedMB == 0 && result.movedBytes > 0)
    let consumed = worker.cleanup(try selections(all))
    precondition(!consumed.errors.isEmpty)

    _ = worker.scan()
    moved.removeAll()
    let forged = worker.cleanup(try selections([("caches", [stale.path])]))
    precondition(!forged.errors.isEmpty && moved.isEmpty)
    _ = worker.scan()
    try Data([8, 9, 10, 11]).write(to: valid)
    let changed = worker.cleanup(try selections([("caches", [validPath])]))
    precondition(!changed.errors.isEmpty && moved.isEmpty)
    _ = worker.scan()
    let duplicate = worker.cleanup(try selections([("caches", [validPath]), ("caches", [validPath])]))
    precondition(duplicate.errors.isEmpty && duplicate.movedCount == 1 && moved.count == 1)
    print("PASS: every category/root, selectable JSON items, permission skipping, stale downloads, unmatched support, privacy exclusions, exact-path cleanup, stale/forged paths, duplicate selection; fixture-only trash stub.")
}

private final class NativeTestDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var controller: ViewController?
    private var attempts = 0
    private var cleaning = false

    @MainActor func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = ViewController()
        self.controller = controller
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentViewController = controller
        self.window = window
        window.makeKeyAndOrderFront(nil)
        poll()
    }

    @MainActor private func poll() {
        attempts += 1
        if attempts > 80 { finish("WKWebView callbacks timed out", success: false); return }
        controller?.verifyNativeTest(cleaning: cleaning) { [weak self] result, error in
            guard let self else { return }
            if let error { self.finish(String(describing: error), success: false); return }
            if let value = result as? String, value == "ready" {
                if self.cleaning { self.finish("PASS: real WKWebView loads signed-build assets, scans every tab, selects actual paths, confirms stub cleanup, and rescans.", success: true); return }
                self.cleaning = true
            } else if let value = result as? String, value.hasPrefix("FAIL:") {
                self.finish(value, success: false); return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.poll() }
        }
    }

    @MainActor private func finish(_ message: String, success: Bool) {
        print(message)
        try? testManager.removeItem(at: nativeTestRoot)
        exit(success ? 0 : 1)
    }
}

extension ViewController {
    fileprivate func verifyNativeTest(cleaning: Bool, completion: @escaping @MainActor @Sendable (Any?, Error?) -> Void) {
        let script = cleaning ? """
            (() => {
              if (document.querySelector('.dialog-body > p').textContent !== 'Cleanup complete.') return 'waiting';
              if (!document.querySelector('.preview-note')?.textContent.includes('Scan complete')) return 'waiting';
              if (document.querySelector('#selection-status').textContent !== 'Selected: 0 items · 0 MB') return 'waiting';
              return 'ready';
            })()
            """ : """
            (() => {
              if (!document.querySelector('.preview-note')?.textContent.includes('Scan complete')) return 'waiting';
              for (const key of ['storage','caches','downloads','applications','startup','performance','privacy']) {
                const button = document.querySelector('button[data-category="' + key + '"]');
                if (!button || button.disabled) return 'FAIL: disabled tab ' + key;
                button.click();
                const boxes = [...document.querySelectorAll('#item-table-body input')];
                if (!boxes.length || boxes.some(box => box.disabled || !box.dataset.path)) return 'FAIL: missing interactive files ' + key;
              }
              document.querySelector('#item-table-body input').click();
              document.querySelector('#btn-review-selected').click();
              if (!document.querySelector('#review-dialog').open) return 'FAIL: review did not open';
              document.querySelector('#review-simulate-btn').click();
              return 'ready';
            })()
            """
        webView?.evaluateJavaScript(script, completionHandler: completion)
    }
}

try runScannerTests()
if CommandLine.arguments.contains("--ui") {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = NativeTestDelegate()
    app.delegate = delegate
    app.run()
} else {
    try testManager.removeItem(at: nativeTestRoot)
}
