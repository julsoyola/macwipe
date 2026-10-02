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
    _ = try writeFixture("Library/Caches/pip/http-v2/response", under: nativeTestHome)
    _ = try writeFixture("Library/Caches/pip/wheels/wheel", under: nativeTestHome)
    _ = try writeFixture("Library/Caches/pip/sessions/state", under: nativeTestHome)
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
    let privateVar = nativeTestSystem.appendingPathComponent("private/var")
    try testManager.createDirectory(at: privateVar, withIntermediateDirectories: true)
    try testManager.createSymbolicLink(at: nativeTestSystem.appendingPathComponent("var"),
                                     withDestinationURL: privateVar)
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
    let finderItem = scan.categories["caches"]!.items.first { $0.name == "valid" }!
    let revealed = try worker.inventoryURL(id: finderItem.id)
    precondition(revealed.path == validPath)
    do { _ = try worker.inventoryURL(id: "/arbitrary/path"); preconditionFailure("Unknown Finder ID accepted") } catch {}
    let startupItem = scan.categories["startup"]!.items[0]
    let startupRevealed = try worker.inventoryURL(id: startupItem.id)
    precondition(startupRevealed.path == startupItem.path)
    let tabs = ["storage", "caches", "downloads", "applications", "startup", "performance", "privacy"]
    for key in tabs {
        let category = scan.categories[key]!
        let readOnly = key == "startup" || key == "performance"
        precondition(category.canClean == !readOnly && category.error == nil && !category.items.isEmpty, key)
        precondition(category.items.allSatisfy {
            $0.canClean == !readOnly && !$0.id.isEmpty && !$0.category.isEmpty && $0.path.hasPrefix("/")
        })
        if readOnly {
            precondition(category.bytes > 0 && category.eligibleBytes == 0)
            precondition(category.items.allSatisfy { !$0.bulkSelectionEligible && !$0.homeRecommendationEligible })
        }
    }
    precondition(scan.categories["caches"]!.items.count == 5)
    precondition(scan.categories["caches"]!.skippedPaths > 0)
    precondition(scan.categories["caches"]!.measurementAvailable && !scan.categories["caches"]!.skippedLocations.isEmpty)
    precondition(scan.categories["downloads"]!.bytes > scan.categories["downloads"]!.eligibleBytes)
    precondition(scan.categories["downloads"]!.items.map(\.name) == ["stale.zip"])
    precondition(scan.categories["downloads"]!.skippedPaths == 0)
    precondition(scan.categories["applications"]!.items.count == 4)
    let unmatched = scan.categories["applications"]!.items.first {
        $0.path.hasSuffix("/UnknownApp")
    }!
    precondition(unmatched.kind == "unmatched-support")
    precondition(unmatched.reviewClassification == "review-carefully")
    precondition(!unmatched.bulkSelectionEligible && !unmatched.homeRecommendationEligible)
    precondition(unmatched.canClean)
    let recognizedCaches = scan.categories["caches"]!.items.filter { $0.bulkSelectionEligible }
    precondition(Set(recognizedCaches.map(\.name)) == ["http-v2", "wheels"])
    precondition(recognizedCaches.allSatisfy { $0.reviewClassification == "temporary" && $0.homeRecommendationEligible && $0.ownerName == "pip" })
    precondition(scan.categories["caches"]!.items.filter { !$0.bulkSelectionEligible }.allSatisfy {
        $0.canClean && $0.reviewClassification == "review-carefully" && !$0.homeRecommendationEligible && !$0.explanation.isEmpty
    })
    precondition(scan.categories["downloads"]!.items.allSatisfy {
        $0.kind == "older-download" && $0.reviewClassification == "review-carefully"
            && !$0.bulkSelectionEligible && $0.homeRecommendationEligible
    })
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
    precondition(!missingScan.categories["downloads"]!.measurementAvailable)
    let categories = encoded["categories"] as! [String: [String: Any]]
    precondition((categories["caches"]!["skippedPaths"] as! Int) > 0)
    let item = (categories["applications"]!["items"] as! [[String: Any]])[0]
    precondition(["id", "category", "path", "name", "bytes", "formatted", "canClean"].allSatisfy { item[$0] != nil })
    let encodedUnmatched = (categories["applications"]!["items"] as! [[String: Any]]).first {
        ($0["path"] as! String) == unmatched.path
    }!
    precondition(encodedUnmatched["kind"] as? String == "unmatched-support")
    precondition(encodedUnmatched["reviewClassification"] as? String == "review-carefully")
    precondition(encodedUnmatched["bulkSelectionEligible"] as? Bool == false)
    precondition(encodedUnmatched["homeRecommendationEligible"] as? Bool == false)

    for category in ["startup", "performance"] {
        let paths = scan.categories[category]!.items.map(\.path)
        let rejected = worker.cleanup(try selections([(category, paths)]))
        precondition(!rejected.errors.isEmpty && rejected.movedCount == 0 && moved.isEmpty)
        _ = worker.scan()
        let legacy = try JSONDecoder().decode([CleanupSelection].self,
            from: JSONSerialization.data(withJSONObject: [category]))
        let legacyRejected = worker.cleanup(legacy)
        precondition(!legacyRejected.errors.isEmpty && legacyRejected.movedCount == 0 && moved.isEmpty)
        _ = worker.scan()
    }
    let systemLog = scan.categories["performance"]!.items.first { $0.path.hasSuffix("/system.log") }!
    precondition(systemLog.path.contains("/private/var/log/") && !systemLog.canClean)
    let disguised = worker.cleanup(try selections([("logs", [systemLog.path])]))
    precondition(!disguised.errors.isEmpty && moved.isEmpty)
    _ = worker.scan()
    let mixed = worker.cleanup(try selections([
        ("caches", [validPath]), ("startup", scan.categories["startup"]!.items.map(\.path))
    ]))
    precondition(!mixed.errors.isEmpty && mixed.movedCount == 0 && moved.isEmpty)
    _ = worker.scan()
    precondition(scan.categories["logs"]!.items.contains { $0.name == "log" && $0.canClean })
    let encodedStartup = categories["startup"]!["items"] as! [[String: Any]]
    precondition(encodedStartup.allSatisfy { $0["canClean"] as? Bool == false })
    let all: [(String, [String])] = Category.allCases.compactMap { category in
        let paths = scan.categories[category.rawValue]!.items.filter { $0.canClean }.map(\.path)
        return paths.isEmpty ? nil : (category.rawValue, paths)
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
    do { _ = try worker.inventoryURL(id: finderItem.id); preconditionFailure("Changed Finder item accepted") } catch {}
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

private func runAppRemovalTests() throws {
    let root = nativeTestRoot.appendingPathComponent("self-removal").resolvingSymlinksInPath()
    func app(_ name: String, identity: String = "app.macwipe.native") throws -> URL {
        let data = try PropertyListSerialization.data(fromPropertyList: [
            "CFBundleIdentifier": identity, "CFBundleExecutable": "macwipe",
            "CFBundlePackageType": "APPL"
        ], format: .xml, options: 0)
        let target = root.appendingPathComponent("Applications/\(name).app")
        _ = try writeFixture("Contents/Info.plist", under: target, data: data)
        let executable = try writeFixture("Contents/MacOS/macwipe", under: target)
        try testManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return target
    }
    let target = try app("macwipe")
    let executable = target.appendingPathComponent("Contents/MacOS/macwipe")
    var events: [String] = []
    // Cancel is represented by not invoking the dedicated removal operation.
    precondition(events.isEmpty && testManager.fileExists(atPath: target.path))
    func refused(_ url: URL, executableURL: URL?, busy: Bool = false) throws {
        do {
            try AppRemoval.perform(bundleURL: url, executableURL: executableURL, busy: busy,
                trash: { _ in events.append("trash") }, quit: { events.append("quit") })
            preconditionFailure("Unsupported removal was allowed")
        } catch { precondition(events.isEmpty) }
    }
    try refused(target, executableURL: executable, busy: true)
    try refused(root.appendingPathComponent("missing.app"), executableURL: executable)
    try refused(target, executableURL: root.appendingPathComponent("wrong-executable"))
    let foreign = try app("foreign", identity: "example.other.app")
    try refused(foreign, executableURL: foreign.appendingPathComponent("Contents/MacOS/macwipe"))
    let alias = root.appendingPathComponent("alias.app")
    try testManager.createSymbolicLink(at: alias, withDestinationURL: target)
    try refused(alias, executableURL: executable)
    let readOnly = try app("read-only")
    try testManager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: readOnly.path)
    try refused(readOnly, executableURL: readOnly.appendingPathComponent("Contents/MacOS/macwipe"))
    try testManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: readOnly.path)
    do {
        try AppRemoval.perform(bundleURL: target, executableURL: executable, busy: false,
            trash: { _ in throw NSError(domain: "fixture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Fixture Trash failure"]) },
            quit: { events.append("quit") })
        preconditionFailure("Trash failure was swallowed")
    } catch { precondition(error.localizedDescription == "Fixture Trash failure" && events.isEmpty) }
    try AppRemoval.perform(bundleURL: target, executableURL: executable, busy: false,
        trash: { precondition($0.path == target.path); events.append("trash") }, quit: { events.append("quit") })
    precondition(events == ["trash", "quit"])
    let otherCopy = try app("macwipe-copy")
    let scanner = FileWorker(home: root.appendingPathComponent("home"), systemRoot: root,
        runningApplicationURL: target, trashItem: { _ in events.append("cleanup") })
    let scan = scanner.scan()
    precondition(!scan.categories["applications"]!.items.contains {
        URL(fileURLWithPath: $0.path).resolvingSymlinksInPath().path == target.resolvingSymlinksInPath().path
    })
    precondition(scan.categories["applications"]!.items.contains {
        URL(fileURLWithPath: $0.path).resolvingSymlinksInPath().path == otherCopy.resolvingSymlinksInPath().path
    })
    let rejected = scanner.cleanup(try selections([("applications", [target.path])]))
    precondition(!rejected.errors.isEmpty && events == ["trash", "quit"])
    print("PASS: cancel/no action, busy, missing/invalid/symlink/read-only bundles, Trash failure without quit, Trash before quit, running app excluded from ordinary cleanup; all mutations mocked.")
}

private func runDownloadRuleTests() throws {
    let home = nativeTestRoot.appendingPathComponent("download-rule/home")
    let now = Date(timeIntervalSince1970: 2_000_000_000)
    let cutoff = now.addingTimeInterval(-30 * 86400)
    let recent = try writeFixture("Downloads/recent.zip", under: home)
    let boundary = try writeFixture("Downloads/boundary.zip", under: home)
    let older = try writeFixture("Downloads/older.zip", under: home)
    _ = try writeFixture("Downloads/folder/nested.zip", under: home)
    try testManager.setAttributes([.modificationDate: cutoff.addingTimeInterval(1)], ofItemAtPath: recent.path)
    try testManager.setAttributes([.modificationDate: cutoff], ofItemAtPath: boundary.path)
    try testManager.setAttributes([.modificationDate: cutoff.addingTimeInterval(-1)], ofItemAtPath: older.path)
    let folder = home.appendingPathComponent("Downloads/folder")
    try testManager.setAttributes([.modificationDate: cutoff.addingTimeInterval(-1)], ofItemAtPath: folder.path)
    let link = home.appendingPathComponent("Downloads/link")
    try testManager.createSymbolicLink(at: link, withDestinationURL: older)
    var moved: [String] = []
    let worker = FileWorker(home: home, systemRoot: nativeTestSystem, trashItem: { moved.append($0.path) })
    let scan = worker.scan(now: now)
    let items = scan.categories["downloads"]!.items
    precondition(items.map(\.name) == ["older.zip"])
    precondition(items[0].modifiedAt == cutoff.timeIntervalSince1970 - 1)
    for path in [recent.path, boundary.path, folder.path, link.path] {
        _ = worker.scan(now: now)
        let result = worker.cleanup(try selections([("downloads", [path])]), now: now)
        precondition(result.movedCount == 0 && !result.errors.isEmpty && moved.isEmpty)
    }
    _ = worker.scan(now: now)
    let changedClock = worker.cleanup(try selections([("downloads", [items[0].path])]), now: now.addingTimeInterval(-2))
    precondition(changedClock.movedCount == 0 && !changedClock.errors.isEmpty && moved.isEmpty)
    _ = worker.scan(now: now)
    let accepted = worker.cleanup(try selections([("downloads", [items[0].path])]), now: now)
    precondition(accepted.movedCount == 1 && accepted.errors.isEmpty && moved == [items[0].path])
    print("PASS: strict 30-day modification boundary, actual timestamp, excluded types, and removal-time eligibility; Trash mocked.")
}

private func runKeepTests() throws {
    let home = nativeTestRoot.appendingPathComponent("keep-rule/home")
    _ = try writeFixture("Library/Caches/pip/http-v2/response", under: home)
    _ = try writeFixture("Library/Caches/pip/wheels/wheel", under: home)
    _ = try writeFixture("Library/Caches/pip-other/file", under: home)
    let suite = "macwipe-fixture-\(UUID().uuidString)"
    let preferences = UserDefaults(suiteName: suite)!
    defer { preferences.removePersistentDomain(forName: suite) }
    var moved: [String] = []
    let worker = FileWorker(home: home, systemRoot: nativeTestSystem, preferences: preferences,
                            trashItem: { moved.append($0.path) })
    let before = worker.scan().categories["caches"]!
    let response = before.items.first { $0.name == "http-v2" }!
    try worker.setKept(id: response.id, kept: true)
    let staleRequest = worker.cleanup(try selections([("caches", [response.path])]))
    precondition(staleRequest.movedCount == 0 && !staleRequest.errors.isEmpty && moved.isEmpty)
    let kept = worker.scan().categories["caches"]!
    let keptResponse = kept.items.first { $0.id == response.id }!
    precondition(keptResponse.kept && !keptResponse.canClean && !keptResponse.bulkSelectionEligible && !keptResponse.homeRecommendationEligible)
    precondition(kept.bytes == before.bytes && keptResponse.bytes == response.bytes)
    let restarted = FileWorker(home: home, systemRoot: nativeTestSystem, preferences: preferences, trashItem: { _ in })
    precondition(restarted.scan().categories["caches"]!.items.first { $0.id == response.id }!.kept)
    try restarted.setKept(id: response.id, kept: false)
    precondition(restarted.scan().categories["caches"]!.items.first { $0.id == response.id }!.canClean)
    let parent = URL(fileURLWithPath: response.path).deletingLastPathComponent().path
    preferences.set([parent], forKey: "macwipe.keptPaths")
    let descendants = FileWorker(home: home, systemRoot: nativeTestSystem, preferences: preferences, trashItem: { _ in }).scan().categories["caches"]!
    precondition(descendants.items.filter { $0.path.hasPrefix(parent + "/") }.allSatisfy { $0.kept && !$0.canClean })
    precondition(descendants.items.first { $0.name == "pip-other" }!.canClean)
    print("PASS: persistent Keep exclusions, unchanged storage accounting, descendants, prefix siblings, reversal, and native stale-approval rejection; Trash mocked.")
}

private func runExplorerTests() throws {
    let home = nativeTestRoot.appendingPathComponent("explorer-rule/home")
    let system = nativeTestRoot.appendingPathComponent("explorer-rule/system")
    for name in ["Documents", "Desktop", "Movies", "Music", "Pictures", "Applications"] {
        try testManager.createDirectory(at: home.appendingPathComponent(name), withIntermediateDirectories: true)
    }
    try testManager.createDirectory(at: system.appendingPathComponent("Applications"), withIntermediateDirectories: true)
    _ = try writeFixture("Documents/inside/data", under: home)
    _ = try writeFixture("Documents/Example.app/Contents/data", under: home)
    _ = try writeFixture("Documents/cloud-only", under: home)
    try testManager.createSymbolicLink(at: home.appendingPathComponent("Downloads"), withDestinationURL: home.appendingPathComponent("Documents/inside"))
    let outside = try writeFixture("outside/private", under: nativeTestRoot)
    try testManager.createSymbolicLink(at: home.appendingPathComponent("Desktop/link"), withDestinationURL: outside)
    let locked = home.appendingPathComponent("Movies")
    try testManager.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
    defer { try? testManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
    let explorer = StorageExplorer(home: home, systemRoot: system, cloudOnly: { $0.lastPathComponent == "cloud-only" })
    let result = explorer.scan()
    precondition(result.status == "partial")
    precondition(result.items.count == 7 && result.items.allSatisfy { !$0.canClean })
    let documents = result.items.first { $0.name == "Documents" }!
    precondition(documents.bytes == 6 && documents.status == "partial")
    precondition(result.items.first { $0.name == "Pictures" }!.bytes == 0)
    precondition(result.items.first { $0.name == "Movies" }!.bytes == nil)
    do { _ = try explorer.url(id: "unknown"); preconditionFailure("Unknown explorer ID accepted") } catch {}
    for index in 0..<150 { _ = try writeFixture("Documents/batch/\(index)", under: home) }
    let control = ScanControl()
    let cancelled = explorer.scan(control: control, progress: { if $0 >= 100 { control.cancel() } })
    precondition(cancelled.status == "cancelled" && cancelled.processedCount <= 100)
    let cancelledBeforeStart = ScanControl(); cancelledBeforeStart.cancel()
    precondition(explorer.scan(control: cancelledBeforeStart).status == "cancelled")
    print("PASS: explorer fixed roots, redirected/nested deduplication, outside symlink and cloud skipping, package logical size, unreadable versus zero, cancellation, and no cleanup registration.")
}

try runScannerTests()
try runExplorerTests()
try runKeepTests()
try runDownloadRuleTests()
try runAppRemovalTests()
if CommandLine.arguments.contains("--ui") {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = NativeTestDelegate()
    app.delegate = delegate
    app.run()
} else {
    try testManager.removeItem(at: nativeTestRoot)
}
