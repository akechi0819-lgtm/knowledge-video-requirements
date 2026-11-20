import AppKit
import WebKit
import Darwin
import Security

// A process group covers the launcher, DSH and its ordinary subprocesses.
// Playwright starts Chromium in a separate session, so collect descendants too.
final class Workbench {
    let output = Pipe()
    private var pid: pid_t = 0

    init(script: URL, data: URL) throws {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawnattr_init(&attributes)
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
        }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)
        let fd = output.fileHandleForWriting.fileDescriptor
        posix_spawn_file_actions_adddup2(&actions, fd, STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&actions, fd, STDERR_FILENO)
        posix_spawn_file_actions_addclose(&actions, fd)
        var argv = [strdup("/bin/bash"), strdup(script.path), strdup(data.path), nil]
        var environment = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            environment.forEach { free($0) }
        }
        let status = posix_spawn(&pid, "/bin/bash", &actions, &attributes, &argv, &environment)
        try output.fileHandleForWriting.close()
        guard status == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(status)) }
    }

    private func descendants(of parent: pid_t) -> [pid_t] {
        let size = proc_listchildpids(parent, nil, 0)
        guard size > 0 else { return [] }
        var children = [pid_t](repeating: 0, count: Int(size))
        let count = children.withUnsafeMutableBytes { proc_listchildpids(parent, $0.baseAddress, Int32($0.count)) }
        let direct = children.prefix(max(0, Int(count))).filter { $0 > 0 }
        return direct + direct.flatMap { descendants(of: $0) }
    }

    func stop() {
        guard pid > 0 else { return }
        let children = descendants(of: pid)
        let groups = [pid] + children.filter { getpgid($0) == $0 }
        let targets = groups.map { -$0 } + children.filter { !groups.contains(getpgid($0)) }
        for target in targets { kill(target, SIGTERM) }
        // Keep the parent PID reserved until all signals to this group are sent.
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline {
            if children.allSatisfy({ kill($0, 0) != 0 }) && leaderHasExited() { break }
            usleep(25_000)
        }
        if pid > 0 {
            for target in targets { kill(target, SIGKILL) }
            while waitpid(pid, nil, 0) < 0 && errno == EINTR {}
            pid = 0
        }
    }

    private func leaderHasExited() -> Bool {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size && info.pbi_status == SZOMB
    }
}

final class Desktop: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
    private let web = WKWebView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private var startupView: WKWebView?
    private var workbench: Workbench?
    private var lock: Int32 = -1
    private var launchOutput = ""
    private var lastStartupLine = ""
    private var workbenchURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu?.addItem(withTitle: "退出讲界", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        editItem.submenu = edit
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        status.alignment = .center
        window.title = "讲界视频工坊"
        window.minSize = NSSize(width: 720, height: 480)
        window.center()
        showStartup()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.navigationDelegate = self
        web.uiDelegate = self
        do {
            try start()
        } catch {
            fail("启动失败。\n\(error.localizedDescription)")
        }
    }

    private func showStartup() {
        let container = NSView(frame: window.contentView!.bounds)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        web.frame = container.bounds
        web.autoresizingMask = [.width, .height]
        container.addSubview(web)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let intro = WKWebView(frame: container.bounds, configuration: configuration)
        intro.autoresizingMask = [.width, .height]
        container.addSubview(intro)
        startupView = intro
        window.contentView = container

        let directory = Bundle.main.resourceURL!.appendingPathComponent("startup", isDirectory: true)
        intro.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo: directory)
    }

    private func start() throws {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let data = ProcessInfo.processInfo.environment["JIANGJIE_DESKTOP_DATA"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? support.appendingPathComponent("讲界", isDirectory: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lock = open(data.appendingPathComponent("desktop.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            fail("讲界已在运行。请切换到已打开的窗口。")
            return
        }
        let script = Bundle.main.resourceURL!.appendingPathComponent("scripts/desktop-dsh.sh").resolvingSymlinksInPath()
        let child = try Workbench(script: script, data: data)
        workbench = child
        child.output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { self?.receive(bytes) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            guard let self, self.workbenchURL == nil, self.workbench != nil else { return }
            self.fail("等待 DSH 启动超时。\n\(self.lastStartupLine)")
        }
    }

    private func receive(_ bytes: Data) {
        guard workbench != nil else { return }
        if bytes.isEmpty {
            fail("本机 DSH 已退出。\n\(lastStartupLine)")
            return
        }
        launchOutput += String(decoding: bytes, as: UTF8.self)
        while let end = launchOutput.firstIndex(of: "\n") {
            let line = launchOutput[..<end]
            if workbenchURL == nil, line.hasPrefix("dsh web: "),
               let url = URL(string: String(line.dropFirst("dsh web: ".count))),
               url.scheme == "http", url.host == "127.0.0.1", let port = url.port {
                let page = URL(string: "http://127.0.0.1:\(port)/bohack/")!
                workbenchURL = page
                web.load(URLRequest(url: page))
            }
            if workbenchURL == nil && !line.isEmpty && !line.contains("token=") {
                lastStartupLine = String(line)
            }
            launchOutput.removeSubrange(...end)
        }
    }

    private func fail(_ message: String) {
        stop()
        dismissStartup()
        status.stringValue = message
        window.contentView = status
    }

    private func dismissStartup() {
        startupView?.removeFromSuperview()
        startupView = nil
    }

    private func stop() {
        let child = workbench
        workbench = nil
        child?.output.fileHandleForReading.readabilityHandler = nil
        child?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        stop()
        if lock >= 0 { close(lock) }
    }

    private func isWorkbench(_ url: URL) -> Bool {
        url.scheme == workbenchURL?.scheme && url.host == workbenchURL?.host && url.port == workbenchURL?.port
            && (url.path == "/bohack" || url.path.hasPrefix("/bohack/"))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isWorkbench(url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else if action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
        } else {
            if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            decisionHandler(.cancel)
            fail("无法打开本机工作台。HTTP \(http.statusCode)")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("无法打开本机工作台。\n\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if startupView != nil {
            fail("无法打开本机工作台。\n\(error.localizedDescription)")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url, isWorkbench(url) { dismissStartup() }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window)
    }
}

// The workbench sends credentials over stdin, never through process arguments.
func keychainCommand() throws {
    guard let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any] else {
        throw NSError(domain: "Keychain", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的钥匙串请求"])
    }
    guard let action = input["action"] as? String, let scope = input["scope"] as? String else {
        throw NSError(domain: "Keychain", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的钥匙串请求"])
    }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "com.jiangjie.desktop.settings",
                                kSecAttrAccount as String: scope]
    var result: AnyObject?
    var status: OSStatus
    if action == "read" {
        var lookup = query
        lookup[kSecReturnData as String] = true
        status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { throw NSError(domain: "Keychain", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "钥匙串中找不到已保存的密钥"]) }
        guard status == errSecSuccess, let data = result as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        FileHandle.standardOutput.write(data)
    } else if action == "write", let keys = input["keys"] as? [String: String] {
        if keys.isEmpty {
            status = SecItemDelete(query as CFDictionary)
            if status != errSecSuccess && status != errSecItemNotFound { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        } else {
            let data = try JSONSerialization.data(withJSONObject: keys)
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var item = query
                item[kSecValueData as String] = data
                status = SecItemAdd(item as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
    } else { throw NSError(domain: "Keychain", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的钥匙串请求"]) }
}

if CommandLine.arguments.dropFirst().first == "--desktop-settings-keychain" {
    do { try keychainCommand(); exit(0) }
    catch { fputs("钥匙串操作失败：\(error.localizedDescription)\n", stderr); exit(1) }
}

let app = NSApplication.shared
let desktop = Desktop()
app.setActivationPolicy(.regular)
app.delegate = desktop
app.run()
