import Cocoa
import ObjectiveC

private var associatedFieldKey: UInt8 = 0

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var contextMenu: NSMenu?
    private var timer: Timer?
    private let label = "com.claude-discord"
    private let menubarLabel = "com.claude-discord-menubar"
    private var botDir: String
    private var plistDst: String
    private var menubarPlistDst: String
    private var envPath: String
    private var langPrefFile: String
    private var skipPermsFile: String
    private var currentVersion: String = "unknown"
    private var updateAvailable: Bool = false
    private var isKorean: Bool = false
    private var controlPanel: NSWindow?
    private var lastKnownRunning: Bool = false
    private var botProcess: Process?
    private var cachedReleaseNotes: String = ""
    private var cachedNewVersion: String = ""

    // Claude Code usage data
    private var usageData: ClaudeUsageData?
    private var usageLastFetched: Date?
    private var usageFetchInFlight = false
    private let usageRefreshCooldown: TimeInterval = 300
    private let usageStaleThreshold: TimeInterval = 300

    override init() {
        let scriptDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        botDir = (scriptDir as NSString).deletingLastPathComponent
        plistDst = NSHomeDirectory() + "/Library/LaunchAgents/com.claude-discord.plist"
        menubarPlistDst = NSHomeDirectory() + "/Library/LaunchAgents/com.claude-discord-menubar.plist"
        envPath = botDir + "/.env"
        langPrefFile = botDir + "/.tray-lang"
        skipPermsFile = botDir + "/.skip-permissions"
        super.init()

        // Load saved language preference
        if let saved = try? String(contentsOfFile: langPrefFile, encoding: .utf8) {
            isKorean = saved.trimmingCharacters(in: .whitespacesAndNewlines) == "kr"
        }
    }

    // MARK: - Localization

    private func L(_ en: String, _ kr: String) -> String {
        return isKorean ? kr : en
    }

    private func setLanguage(_ korean: Bool) {
        isKorean = korean
        try? (korean ? "kr" : "en").write(toFile: langPrefFile, atomically: true, encoding: .utf8)
        updateStatus()
        buildMenu()
        rebuildControlPanel()
    }

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SIGTERM/SIGINT/SIGHUP — panel must take the bot down with it.
        // applicationWillTerminate is not called for raw signals, so install handlers explicitly.
        let cleanupAndExit: @convention(c) (Int32) -> Void = { _ in
            // Best-effort: spawn pkill via posix_spawn (system() is unavailable on macOS Swift).
            var pid: pid_t = 0
            var argv: [UnsafeMutablePointer<CChar>?] = [
                strdup("/usr/bin/pkill"),
                strdup("-KILL"),
                strdup("-f"),
                strdup("node dist/index.js"),
                nil,
            ]
            posix_spawn(&pid, "/usr/bin/pkill", nil, nil, argv, nil)
            for p in argv { free(p) }
            exit(0)
        }
        signal(SIGTERM, cleanupAndExit)
        signal(SIGINT, cleanupAndExit)
        signal(SIGHUP, cleanupAndExit)

        // Enable Cmd+C/V/X/A in text fields (required for LSUIElement apps without a nib)
        let mainMenu = NSMenu()
        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApp.mainMenu = mainMenu

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Handle left-click vs right-click on status item
        if let button = statusItem.button {
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.target = self
            button.action = #selector(statusItemClicked(_:))
        }

        currentVersion = getVersion()

        // One-time migration: remove legacy launchd-managed bot plist so launchd
        // doesn't auto-start the bot at boot. The panel manages bot lifecycle now.
        migrateAwayFromBotPlist()

        checkForUpdates()
        updateStatus()
        buildMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let prevRunning = self.lastKnownRunning
            let nowRunning = self.isRunning()
            self.updateStatus()
            self.buildMenu()
            if self.controlPanel?.isVisible == true {
                // Only rebuild panel when running state actually changes (avoids flicker)
                if prevRunning != nowRunning {
                    self.rebuildControlPanel()
                }
                self.fetchUsageIfStale()
            }
            self.lastKnownRunning = nowRunning
        }
        // Check for updates every 5 hours
        Timer.scheduledTimer(withTimeInterval: 18000, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
        loadUsageCache(forceReload: true)
        fetchUsageIfStale()
        // 첫 실행 시 컨트롤 패널 표시 (.env 미설정이면 설정 다이얼로그도 함께)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.showControlPanel()
            if !self.isEnvConfigured() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.openSettings()
                }
            } else {
                // Auto-start the bot once when panel launches (e.g. after Mac boot)
                self.startBot()
            }
        }
    }

    // MARK: - Env Configuration Check

    private func isEnvConfigured() -> Bool {
        guard FileManager.default.fileExists(atPath: envPath) else { return false }
        let env = loadEnv()
        let exampleValues: Set<String> = [
            "your_bot_token_here", "your_server_id_here", "your_user_id_here",
            "/Users/yourname/projects", "/Users/you/projects"
        ]
        guard let token = env["DISCORD_BOT_TOKEN"], !token.isEmpty, !exampleValues.contains(token) else { return false }
        guard let guild = env["DISCORD_GUILD_ID"], !guild.isEmpty, !exampleValues.contains(guild) else { return false }
        return true
    }

    private func getVersion() -> String {
        let output = runShell("cd '\(botDir)' && git describe --tags --always 2>/dev/null")
        let ver = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return ver.isEmpty ? "unknown" : ver
    }

    private func checkForUpdates() {
        DispatchQueue.global(qos: .background).async {
            self.runShell("cd '\(self.botDir)' && git fetch origin main --tags 2>/dev/null")
            let local = self.runShell("cd '\(self.botDir)' && git rev-parse HEAD 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
            let remote = self.runShell("cd '\(self.botDir)' && git rev-parse origin/main 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
            let hasUpdate = !local.isEmpty && !remote.isEmpty && local != remote
            if hasUpdate {
                self.fetchReleaseNotes()
            }
            DispatchQueue.main.async {
                self.updateAvailable = hasUpdate
                self.buildMenu()
                self.rebuildControlPanel()
            }
        }
    }

    // MARK: - Release Notes

    private func fetchReleaseNotes() {
        guard let url = URL(string: "https://api.github.com/repos/chadingTV/claudecode-discord/releases") else { return }
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github.v3+json", forHTTPHeaderField: "Accept")
        request.setValue("claudecode-discord-tray", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 10

        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { semaphore.signal() }
            guard let data = data,
                  let releases = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }

            let currentTag = self.extractTag(from: self.currentVersion)
            let currentParts = self.parseVersion(currentTag)
            var notes: [(tag: String, body: String)] = []
            var latestTag = currentTag

            for release in releases {
                guard let tagName = release["tag_name"] as? String,
                      let body = release["body"] as? String,
                      !(release["draft"] as? Bool ?? false) else { continue }
                let rParts = self.parseVersion(tagName)
                if self.isNewer(rParts, than: currentParts) {
                    notes.append((tag: tagName, body: body))
                    if self.isNewer(rParts, than: self.parseVersion(latestTag)) {
                        latestTag = tagName
                    }
                }
            }

            notes.sort { self.isNewer(self.parseVersion($1.tag), than: self.parseVersion($0.tag)) }

            let formatted = notes.map { "━━━ \($0.tag) ━━━\n\(self.stripMarkdown($0.body))" }
                .joined(separator: "\n\n")

            DispatchQueue.main.async {
                self.cachedReleaseNotes = formatted
                self.cachedNewVersion = latestTag
            }
        }.resume()
        semaphore.wait()
    }

    private func extractTag(from version: String) -> String {
        let parts = version.split(separator: "-")
        if parts.count >= 3, parts.last?.hasPrefix("g") == true {
            return String(parts.dropLast(2).joined(separator: "-"))
        }
        return version
    }

    private func parseVersion(_ tag: String) -> [Int] {
        let cleaned = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        return cleaned.split(separator: ".").compactMap { Int($0) }
    }

    private func isNewer(_ a: [Int], than b: [Int]) -> Bool {
        for i in 0..<max(a.count, b.count) {
            let av = i < a.count ? a[i] : 0
            let bv = i < b.count ? b[i] : 0
            if av > bv { return true }
            if av < bv { return false }
        }
        return false
    }

    private func stripMarkdown(_ text: String) -> String {
        var result = text.replacingOccurrences(of: "**", with: "")
        if let regex = try? NSRegularExpression(pattern: "\\[([^\\]]+)\\]\\([^)]+\\)") {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1")
        }
        result = result.components(separatedBy: "\n")
            .filter { !$0.contains("Full Changelog:") }
            .joined(separator: "\n")
        while result.contains("\n\n\n") {
            result = result.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @objc private func checkUpdateClicked() {
        checkForUpdates()
        if !updateAvailable {
            let alert = NSAlert()
            alert.messageText = L("No Updates", "업데이트 없음")
            alert.informativeText = L("You are running the latest version.", "최신 버전을 사용 중입니다.")
            alert.alertStyle = .informational
            alert.runModal()
        }
    }

    @objc private func performUpdate() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = L("Update Available", "업데이트 가능")

        let versionInfo = cachedNewVersion.isEmpty ? "" : "\(currentVersion) → \(cachedNewVersion)\n\n"
        alert.informativeText = versionInfo + L(
            "Do you want to update? The bot and menu bar app will restart.",
            "업데이트하시겠습니까? 봇과 메뉴바 앱이 재시작됩니다."
        )
        alert.alertStyle = .informational
        alert.addButton(withTitle: L("Update", "업데이트"))
        alert.addButton(withTitle: L("Cancel", "취소"))

        if !cachedReleaseNotes.isEmpty {
            let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 250))
            scrollView.hasVerticalScroller = true
            scrollView.autohidesScrollers = true
            let textView = NSTextView(frame: scrollView.bounds)
            textView.string = cachedReleaseNotes
            textView.isEditable = false
            textView.isSelectable = true
            textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
            textView.textContainerInset = NSSize(width: 8, height: 8)
            if #available(macOS 10.14, *) {
                textView.backgroundColor = .controlBackgroundColor
            }
            scrollView.documentView = textView
            alert.accessoryView = scrollView
        }

        if alert.runModal() == .alertFirstButtonReturn {
            let wasRunning = isRunning()
            if wasRunning {
                stopBot()
            }

            runShell("cd '\(botDir)' && git fetch origin main --tags")
            let pullOutput = runShell("cd '\(botDir)' && git reset --hard origin/main 2>&1")

            // Check if pull succeeded
            let afterPull = runShell("cd '\(botDir)' && git rev-parse HEAD").trimmingCharacters(in: .whitespacesAndNewlines)
            let remote = runShell("cd '\(botDir)' && git rev-parse origin/main").trimmingCharacters(in: .whitespacesAndNewlines)
            if !afterPull.isEmpty && !remote.isEmpty && afterPull != remote {
                let errAlert = NSAlert()
                errAlert.messageText = L("Update Failed", "업데이트 실패")
                errAlert.informativeText = L("git pull failed:\n", "git pull 실패:\n") + pullOutput
                errAlert.alertStyle = .critical
                errAlert.runModal()
                if wasRunning {
                    startBot()
                }
                return
            }

            let output = runShell("cd '\(botDir)' && npm install && npm rebuild better-sqlite3 && npm run build 2>&1")

            currentVersion = getVersion()
            updateAvailable = false

            // Rebuild the menu bar app itself and restart
            let swiftSrc = "\(botDir)/menubar/ClaudeBotMenu.swift"
            let swiftBin = "\(botDir)/menubar/ClaudeBotMenu"
            if FileManager.default.fileExists(atPath: swiftSrc) {
                // Accept Xcode license if needed before compiling
                let xcrunCheck = runShell("xcrun --find swiftc 2>&1")
                if xcrunCheck.contains("license") || xcrunCheck.contains("error") {
                    runShell("osascript -e 'do shell script \"xcodebuild -license accept\" with administrator privileges' 2>/dev/null")
                }
                runShell("swiftc -o '\(swiftBin)' '\(swiftSrc)' -framework Cocoa 2>&1")

                if wasRunning {
                    startBot()
                }

                // Restart menu bar app (detached from terminal)
                runShell("nohup bash -c 'sleep 1 && \"\(swiftBin)\"' > /dev/null 2>&1 &")

                NSApplication.shared.terminate(nil)
                return
            }

            if wasRunning {
                startBot()
            }

            let doneAlert = NSAlert()
            doneAlert.messageText = L("Update Complete", "업데이트 완료")
            doneAlert.informativeText = L("Updated to version: ", "업데이트된 버전: ") + currentVersion + "\n\n" + output
            doneAlert.alertStyle = .informational
            doneAlert.runModal()

            updateStatus()
            buildMenu()
        }
    }

    private func isRunning() -> Bool {
        // Single source of truth: panel spawns the bot as a child Process and tracks it.
        return botProcess?.isRunning ?? false
    }

    private func updateStatus() {
        let running = isRunning()
        let hasEnv = isEnvConfigured()
        DispatchQueue.main.async {
            if !hasEnv {
                self.statusItem.button?.title = " \u{2699}\u{FE0F}"
                self.statusItem.button?.toolTip = self.L("Claude Bot: Setup Required", "Claude Bot: 설정 필요")
            } else {
                self.statusItem.button?.title = running ? " \u{1F7E2}" : " \u{1F534}"
                self.statusItem.button?.toolTip = running
                    ? self.L("Claude Bot: Running", "Claude Bot: 실행 중")
                    : self.L("Claude Bot: Stopped", "Claude Bot: 중지됨")
            }
        }
    }

    private func buildMenu() {
        let menu = NSMenu()
        let running = isRunning()
        let hasEnv = isEnvConfigured()

        if !hasEnv {
            let noEnvItem = NSMenuItem(title: L("\u{2699}\u{FE0F} Setup Required", "\u{2699}\u{FE0F} 설정 필요"), action: nil, keyEquivalent: "")
            noEnvItem.isEnabled = false
            menu.addItem(noEnvItem)
            menu.addItem(NSMenuItem.separator())

            let setupItem = NSMenuItem(title: L("Setup...", "설정..."), action: #selector(openSettings), keyEquivalent: "e")
            setupItem.target = self
            menu.addItem(setupItem)
        } else {
            let statusText = running
                ? L("\u{1F7E2} Running", "\u{1F7E2} 실행 중")
                : L("\u{1F534} Stopped", "\u{1F534} 중지됨")
            let statusItem = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
            statusItem.isEnabled = false
            menu.addItem(statusItem)
            menu.addItem(NSMenuItem.separator())

            // Control Panel
            let panelItem = NSMenuItem(title: L("Open Control Panel", "컨트롤 패널 열기"), action: #selector(showControlPanel), keyEquivalent: "p")
            panelItem.target = self
            menu.addItem(panelItem)

            menu.addItem(NSMenuItem.separator())

            if running {
                let stopItem = NSMenuItem(title: L("Stop Bot", "봇 중지"), action: #selector(stopBot), keyEquivalent: "s")
                stopItem.target = self
                menu.addItem(stopItem)

                let restartItem = NSMenuItem(title: L("Restart Bot", "봇 재시작"), action: #selector(restartBot), keyEquivalent: "r")
                restartItem.target = self
                menu.addItem(restartItem)
            } else {
                let startItem = NSMenuItem(title: L("Start Bot", "봇 시작"), action: #selector(startBot), keyEquivalent: "s")
                startItem.target = self
                menu.addItem(startItem)
            }

            menu.addItem(NSMenuItem.separator())

            let settingsItem = NSMenuItem(title: L("Settings...", "설정..."), action: #selector(openSettings), keyEquivalent: "e")
            settingsItem.target = self
            menu.addItem(settingsItem)

            let logItem = NSMenuItem(title: L("View Log", "로그 보기"), action: #selector(openLog), keyEquivalent: "l")
            logItem.target = self
            menu.addItem(logItem)

            let folderItem = NSMenuItem(title: L("Open Folder", "폴더 열기"), action: #selector(openFolder), keyEquivalent: "f")
            folderItem.target = self
            menu.addItem(folderItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Skip Permissions toggle (dangerous)
        let skipPermsItem = NSMenuItem(
            title: L("Skip Permissions (⚠️ dangerous)",
                     "권한 건너뛰기 (⚠️ 위험)"),
            action: #selector(toggleSkipPermissions),
            keyEquivalent: "")
        skipPermsItem.target = self
        skipPermsItem.state = isSkipPermissionsEnabled() ? .on : .off
        menu.addItem(skipPermsItem)

        // Auto-start toggle
        let autoStartItem = NSMenuItem(title: L("Launch on System Startup", "시스템 시작 시 자동 실행"), action: #selector(toggleAutoStart), keyEquivalent: "")
        autoStartItem.target = self
        autoStartItem.state = isAutoStartEnabled() ? .on : .off
        menu.addItem(autoStartItem)

        // Language toggle submenu
        let langItem = NSMenuItem(title: isKorean ? "Language: KR" : "Language: EN", action: nil, keyEquivalent: "")
        let langMenu = NSMenu()
        let enItem = NSMenuItem(title: "English", action: #selector(switchToEN), keyEquivalent: "")
        enItem.target = self
        enItem.state = !isKorean ? .on : .off
        langMenu.addItem(enItem)
        let krItem = NSMenuItem(title: "한국어", action: #selector(switchToKR), keyEquivalent: "")
        krItem.target = self
        krItem.state = isKorean ? .on : .off
        langMenu.addItem(krItem)
        langItem.submenu = langMenu
        menu.addItem(langItem)

        // Version & update
        let versionItem = NSMenuItem(title: L("Version: ", "버전: ") + currentVersion, action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

        if updateAvailable {
            let updateItem = NSMenuItem(title: L("\u{2B06}\u{FE0F} Update Available", "\u{2B06}\u{FE0F} 업데이트 가능"), action: #selector(performUpdate), keyEquivalent: "u")
            updateItem.target = self
            menu.addItem(updateItem)
        } else {
            let checkItem = NSMenuItem(title: L("Check for Updates", "업데이트 확인"), action: #selector(checkUpdateClicked), keyEquivalent: "")
            checkItem.target = self
            menu.addItem(checkItem)
        }

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: L("Quit", "종료"), action: #selector(quitAll), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        self.contextMenu = menu
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp {
            // Right-click: show context menu
            if let menu = contextMenu {
                statusItem.menu = menu
                statusItem.button?.performClick(nil)
                statusItem.menu = nil  // Reset so next click goes through action
            }
        } else {
            // Left-click: open control panel
            showControlPanel()
        }
    }

    @objc private func switchToEN() { setLanguage(false) }
    @objc private func switchToKR() { setLanguage(true) }

    // MARK: - Claude Code Usage

    private var usageCachePath: String {
        let home = NSHomeDirectory()
        return "\(home)/.claude/.usage-cache.json"
    }

    private func usageCacheModifiedAt() -> Date? {
        let path = usageCachePath
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
        return attrs[.modificationDate] as? Date
    }

    private func saveUsageCache(json: [String: Any]) {
        var cache = json
        cache["_fetched_at"] = ISO8601DateFormatter().string(from: Date())
        if let data = try? JSONSerialization.data(withJSONObject: cache) {
            try? data.write(to: URL(fileURLWithPath: usageCachePath))
        }
    }

    private func loadUsageCache(forceReload: Bool = false) {
        if usageData != nil && !forceReload { return }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: usageCachePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        var usage = ClaudeUsageData()
        if let fiveHour = json["five_hour"] as? [String: Any],
           let util = fiveHour["utilization"] as? Double {
            usage.fiveHour = ClaudeUsageTier(utilization: util / 100.0, resetsAt: fiveHour["resets_at"] as? String)
        }
        if let sevenDay = json["seven_day"] as? [String: Any],
           let util = sevenDay["utilization"] as? Double {
            usage.sevenDay = ClaudeUsageTier(utilization: util / 100.0, resetsAt: sevenDay["resets_at"] as? String)
        }
        if let sonnet = json["seven_day_sonnet"] as? [String: Any],
           let util = sonnet["utilization"] as? Double {
            usage.sevenDaySonnet = ClaudeUsageTier(utilization: util / 100.0, resetsAt: sonnet["resets_at"] as? String)
        }

        if let fetchedStr = json["_fetched_at"] as? String {
            let fmt = ISO8601DateFormatter()
            usageLastFetched = fmt.date(from: fetchedStr)
        } else {
            usageLastFetched = usageCacheModifiedAt()
        }
        usageData = usage
    }

    private func fetchUsageIfStale() {
        let now = Date()
        // Check in-memory timestamp first
        if let lastFetch = usageLastFetched, now.timeIntervalSince(lastFetch) < usageStaleThreshold {
            return
        }
        // Fallback: check cache file _fetched_at (survives app restart)
        if usageLastFetched == nil, let data = try? Data(contentsOf: URL(fileURLWithPath: usageCachePath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let fetchedStr = json["_fetched_at"] as? String,
           let fetchedDate = ISO8601DateFormatter().date(from: fetchedStr),
           now.timeIntervalSince(fetchedDate) < usageStaleThreshold {
            usageLastFetched = fetchedDate
            return
        }
        fetchUsage()
    }

    private func readCredentialsJSON() -> (String, [String: Any])? {
        // Try credentials file first (cross-platform)
        let credPath = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/.credentials.json")
        if let data = try? Data(contentsOf: URL(fileURLWithPath: credPath)),
           let raw = String(data: data, encoding: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return (raw, json)
        }

        // macOS: read from keychain via security command
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
        } catch { return nil }
        guard task.terminationStatus == 0 else { return nil }
        let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty,
              let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (raw, json)
    }

    // In-memory cache for refreshed token (avoid keychain write)
    private var cachedAccessToken: String?
    private var cachedTokenExpiresAt: Int64 = 0

    private func isTokenExpired(_ json: [String: Any]) -> Bool {
        guard let oauth = json["claudeAiOauth"] as? [String: Any],
              let expiresAt = oauth["expiresAt"] as? Int64 else { return false }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        return nowMs >= (expiresAt - 300000) // 5 min buffer
    }

    private func refreshOAuthToken(_ credJson: String, _ json: [String: Any]) -> String? {
        guard let oauth = json["claudeAiOauth"] as? [String: Any],
              let refreshToken = oauth["refreshToken"] as? String else { return nil }

        let postData = "grant_type=refresh_token"
            + "&refresh_token=\(refreshToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? refreshToken)"
            + "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"
            + "&scope=user:profile%20user:inference%20user:sessions:claude_code%20user:mcp_servers%20user:file_upload"

        guard let url = URL(string: "https://platform.claude.com/v1/oauth/token") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = postData.data(using: .utf8)

        let semaphore = DispatchSemaphore(value: 0)
        var newAccessToken: String?

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            defer { semaphore.signal() }
            guard error == nil,
                  let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200,
                  let data = data,
                  let tokenJson = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let newAccess = tokenJson["access_token"] as? String else { return }

            let expiresIn = tokenJson["expires_in"] as? Int64 ?? 3600
            let newExpiresAt = Int64(Date().timeIntervalSince1970 * 1000) + expiresIn * 1000

            // Store in memory only (no keychain write)
            self?.cachedAccessToken = newAccess
            self?.cachedTokenExpiresAt = newExpiresAt
            newAccessToken = newAccess
        }.resume()

        _ = semaphore.wait(timeout: .now() + 20)
        return newAccessToken
    }

    private func getAccessToken() -> String? {
        // Use cached token if still valid
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        if let cached = cachedAccessToken, cachedTokenExpiresAt > nowMs + 300000 {
            return cached
        }

        guard let (credJson, json) = readCredentialsJSON() else { return nil }
        guard let oauth = json["claudeAiOauth"] as? [String: Any] else { return nil }

        // Auto-refresh if expired
        if isTokenExpired(json) {
            if let token = refreshOAuthToken(credJson, json) {
                return token
            }
        }

        return oauth["accessToken"] as? String
    }

    private func fetchUsageViaAPI() -> [String: Any]? {
        guard let token = getAccessToken() else { return nil }
        guard let url = URL(string: "https://api.anthropic.com/api/oauth/usage") else { return nil }

        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")

        let semaphore = DispatchSemaphore(value: 0)
        var result: [String: Any]?
        var statusCode = 0

        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let httpRes = response as? HTTPURLResponse { statusCode = httpRes.statusCode }
            guard error == nil,
                  let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            result = json
        }.resume()

        _ = semaphore.wait(timeout: .now() + 12)

        // 401: retry after token refresh
        if result == nil && statusCode == 401 {
            if let (credJson, json) = readCredentialsJSON(),
               let newToken = refreshOAuthToken(credJson, json) {
                var retryReq = URLRequest(url: url, timeoutInterval: 10)
                retryReq.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
                retryReq.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
                let sem2 = DispatchSemaphore(value: 0)
                URLSession.shared.dataTask(with: retryReq) { data, response, error in
                    defer { sem2.signal() }
                    guard error == nil,
                          let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200,
                          let data = data,
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                    result = json
                }.resume()
                _ = sem2.wait(timeout: .now() + 12)
            }
        }

        return result
    }

    private func fetchUsage(force: Bool = false, openPageOnFail: Bool = false) {
        if usageFetchInFlight { return }
        if !force, let lastFetch = usageLastFetched, Date().timeIntervalSince(lastFetch) < usageRefreshCooldown {
            return
        }

        usageFetchInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            guard let json = self.fetchUsageViaAPI(),
                  json["five_hour"] != nil || json["seven_day"] != nil || json["seven_day_sonnet"] != nil else {
                DispatchQueue.main.async {
                    self.usageFetchInFlight = false
                    self.rebuildControlPanel()
                    if self.usageData == nil && openPageOnFail {
                        self.openUsagePage()
                    }
                }
                return
            }

            self.saveUsageCache(json: json)

            DispatchQueue.main.async {
                self.usageFetchInFlight = false
                self.loadUsageCache(forceReload: true)
                self.rebuildControlPanel()
            }
        }
    }

    private func formatResetTime(_ isoString: String?) -> String {
        guard let isoString = isoString else { return "" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString) ?? ISO8601DateFormatter().date(from: isoString) else { return "" }
        let diff = date.timeIntervalSinceNow
        if diff <= 0 { return L("Resetting...", "초기화 중...") }
        let hours = Int(diff) / 3600
        let minutes = (Int(diff) % 3600) / 60
        if hours > 0 {
            return L("Resets in \(hours)h", "\(hours)시간 후 초기화")
        } else {
            return L("Resets in \(minutes)m", "\(minutes)분 후 초기화")
        }
    }

    @objc private func fetchUsageClicked() {
        fetchUsage(force: true, openPageOnFail: true)
    }

    // MARK: - Control Panel Window

    @objc private func showControlPanel() {
        NSApp.activate(ignoringOtherApps: true)

        // If already open, bring to front
        if let panel = controlPanel, panel.isVisible {
            panel.makeKeyAndOrderFront(nil)
            return
        }

        let panelWidth: CGFloat = 440
        let panelHeight: CGFloat = 580

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Claude Discord Bot"
        window.center()
        window.isReleasedWhenClosed = false
        controlPanel = window

        rebuildControlPanel()
        fetchUsageIfStale()

        window.makeKeyAndOrderFront(nil)
    }

    private func rebuildControlPanel() {
        guard let window = controlPanel else { return }

        let panelWidth = window.frame.width
        let contentWidth = panelWidth - 60
        let halfWidth = (contentWidth - 10) / 2
        let running = isRunning()
        let hasEnv = isEnvConfigured()

        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: 580))
        contentView.wantsLayer = true

        var elements: [(view: NSView, height: CGFloat)] = []

        // Header: Icon + Title + Language toggle
        let headerContainer = NSView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 52))

        // App icon (rounded)
        let iconPath = "\(botDir)/docs/icon-rounded.png"
        if FileManager.default.fileExists(atPath: iconPath),
           let iconImage = NSImage(contentsOfFile: iconPath) {
            let iconView = NSImageView(frame: NSRect(x: 0, y: 6, width: 44, height: 44))
            iconView.image = iconImage
            iconView.imageScaling = .scaleProportionallyUpOrDown
            iconView.wantsLayer = true
            iconView.layer?.cornerRadius = 10
            iconView.layer?.masksToBounds = true
            headerContainer.addSubview(iconView)
        }

        // Title
        let titleLabel = NSTextField(labelWithString: "Claude Discord Bot")
        titleLabel.frame = NSRect(x: 52, y: 22, width: 250, height: 22)
        titleLabel.font = NSFont.boldSystemFont(ofSize: 16)
        headerContainer.addSubview(titleLabel)

        // Version under title
        let verSmallLabel = NSTextField(labelWithString: currentVersion)
        verSmallLabel.frame = NSRect(x: 52, y: 6, width: 250, height: 16)
        verSmallLabel.font = NSFont.systemFont(ofSize: 11)
        verSmallLabel.textColor = .secondaryLabelColor
        headerContainer.addSubview(verSmallLabel)

        // Language toggle (EN | KR) at top-right
        let enBtn = createLangButton(title: "EN", selected: !isKorean)
        enBtn.frame = NSRect(x: contentWidth - 70, y: 18, width: 32, height: 22)
        enBtn.target = self
        enBtn.action = #selector(switchToEN)
        headerContainer.addSubview(enBtn)

        let divider = NSTextField(labelWithString: "|")
        divider.frame = NSRect(x: contentWidth - 38, y: 18, width: 10, height: 22)
        divider.alignment = .center
        divider.textColor = .tertiaryLabelColor
        headerContainer.addSubview(divider)

        let krBtn = createLangButton(title: "KR", selected: isKorean)
        krBtn.frame = NSRect(x: contentWidth - 28, y: 18, width: 32, height: 22)
        krBtn.target = self
        krBtn.action = #selector(switchToKR)
        headerContainer.addSubview(krBtn)

        elements.append((headerContainer, 52))

        // Separator after header
        elements.append((createSeparator(width: contentWidth), 12))

        // Status indicator
        let statusContainer = NSView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 50))
        statusContainer.wantsLayer = true
        statusContainer.layer?.backgroundColor = NSColor(white: 0.5, alpha: 0.08).cgColor
        statusContainer.layer?.cornerRadius = 10

        let statusColor: NSColor = !hasEnv ? .orange : (running ? .systemGreen : .systemRed)
        let statusText = !hasEnv
            ? L("Setup Required", "설정 필요")
            : (running ? L("Running", "실행 중") : L("Stopped", "중지됨"))

        let dot = StatusDot(color: statusColor)
        dot.frame = NSRect(x: 16, y: 15, width: 20, height: 20)
        statusContainer.addSubview(dot)

        let statusLabel = NSTextField(labelWithString: statusText)
        statusLabel.frame = NSRect(x: 44, y: 13, width: 300, height: 24)
        statusLabel.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        statusContainer.addSubview(statusLabel)

        elements.append((statusContainer, 50))

        // Claude Code Usage section
        if let usage = usageData {
            let usageContainer = NSView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 10))
            usageContainer.wantsLayer = true
            usageContainer.layer?.backgroundColor = NSColor(white: 0.5, alpha: 0.08).cgColor
            usageContainer.layer?.cornerRadius = 10

            var usageItems: [(String, Double, String)] = []
            if let fh = usage.fiveHour {
                usageItems.append((L("Session (5hr)", "세션 (5시간)"), fh.utilization, formatResetTime(fh.resetsAt)))
            }
            if let sd = usage.sevenDay {
                usageItems.append((L("Weekly (7 day)", "주간 (7일)"), sd.utilization, formatResetTime(sd.resetsAt)))
            }
            if let ss = usage.sevenDaySonnet {
                usageItems.append((L("Weekly Sonnet", "주간 Sonnet"), ss.utilization, formatResetTime(ss.resetsAt)))
            }

            let itemHeight: CGFloat = 44
            let padding: CGFloat = 12
            let totalUsageHeight = CGFloat(usageItems.count) * itemHeight + padding * 2

            var yOffset = totalUsageHeight - padding
            for (label, util, resetText) in usageItems {
                yOffset -= itemHeight
                let percent = Int(util * 100)

                // Label + percentage
                let nameLabel = NSTextField(labelWithString: label)
                nameLabel.frame = NSRect(x: 14, y: yOffset + 22, width: 200, height: 16)
                nameLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
                nameLabel.textColor = .secondaryLabelColor
                usageContainer.addSubview(nameLabel)

                let pctLabel = NSTextField(labelWithString: "\(percent)%")
                pctLabel.frame = NSRect(x: contentWidth - 54, y: yOffset + 22, width: 40, height: 16)
                pctLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
                pctLabel.textColor = util > 0.9 ? .systemRed : (util > 0.7 ? .systemOrange : .labelColor)
                pctLabel.alignment = .right
                usageContainer.addSubview(pctLabel)

                // Progress bar background
                let barWidth = contentWidth - 28
                let barBg = NSView(frame: NSRect(x: 14, y: yOffset + 6, width: barWidth, height: 8))
                barBg.wantsLayer = true
                barBg.layer?.backgroundColor = NSColor(white: 0.5, alpha: 0.15).cgColor
                barBg.layer?.cornerRadius = 4
                usageContainer.addSubview(barBg)

                // Progress bar fill
                let fillWidth = max(0, min(barWidth, barWidth * CGFloat(util)))
                let barFill = NSView(frame: NSRect(x: 14, y: yOffset + 6, width: fillWidth, height: 8))
                barFill.wantsLayer = true
                let barColor: NSColor = util > 0.9 ? .systemRed : (util > 0.7 ? .systemOrange : .systemBlue)
                barFill.layer?.backgroundColor = barColor.cgColor
                barFill.layer?.cornerRadius = 4
                usageContainer.addSubview(barFill)

                // Reset time
                if !resetText.isEmpty {
                    let resetLabel = NSTextField(labelWithString: resetText)
                    resetLabel.frame = NSRect(x: 14, y: yOffset - 8, width: barWidth, height: 12)
                    resetLabel.font = NSFont.systemFont(ofSize: 9)
                    resetLabel.textColor = .tertiaryLabelColor
                    usageContainer.addSubview(resetLabel)
                }
            }

            // Last fetched time label
            var lastFetchedText = ""
            if let fetched = usageLastFetched {
                let ago = Int(Date().timeIntervalSince(fetched))
                if ago < 60 {
                    lastFetchedText = L("Updated just now", "방금 갱신됨")
                } else if ago < 3600 {
                    lastFetchedText = L("Updated \(ago / 60)m ago", "\(ago / 60)분 전 갱신")
                } else {
                    lastFetchedText = L("Updated \(ago / 3600)h ago", "\(ago / 3600)시간 전 갱신")
                }
            }
            if !lastFetchedText.isEmpty {
                let fetchedLabel = NSTextField(labelWithString: lastFetchedText)
                fetchedLabel.frame = NSRect(x: 14, y: 4, width: contentWidth - 28, height: 12)
                fetchedLabel.font = NSFont.systemFont(ofSize: 9)
                fetchedLabel.textColor = .tertiaryLabelColor
                fetchedLabel.alignment = .right
                usageContainer.addSubview(fetchedLabel)
            }

            let finalHeight = totalUsageHeight + (lastFetchedText.isEmpty ? 0 : 8)
            usageContainer.frame = NSRect(x: 0, y: 0, width: contentWidth, height: finalHeight)

            // Clickable overlay to open usage page in browser
            let clickBtn = NSButton(frame: NSRect(x: 0, y: 0, width: contentWidth, height: finalHeight))
            clickBtn.title = ""
            clickBtn.isBordered = false
            clickBtn.isTransparent = true
            clickBtn.target = self
            clickBtn.action = #selector(openUsagePage)
            usageContainer.addSubview(clickBtn)

            elements.append((usageContainer, finalHeight))
        } else {
            // Cache stays as fallback. Manual refresh asks Claude itself to refresh usage data.
            let fetchBtn = createStyledButton(
                title: L("Load Usage Info", "사용량 정보 불러오기"), width: contentWidth,
                bgColor: NSColor(white: 0.5, alpha: 0.08), fgColor: .secondaryLabelColor
            )
            fetchBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 30)
            fetchBtn.target = self
            fetchBtn.action = #selector(fetchUsageClicked)
            elements.append((fetchBtn, 34))
        }

        // Bot control buttons
        if hasEnv {
            let controlContainer = NSView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 40))
            if running {
                let stopBtn = createStyledButton(
                    title: L("Stop Bot", "봇 중지"), width: halfWidth,
                    bgColor: NSColor.systemRed.withAlphaComponent(0.12), fgColor: .systemRed
                )
                stopBtn.frame = NSRect(x: 0, y: 0, width: halfWidth, height: 36)
                stopBtn.target = self
                stopBtn.action = #selector(stopBotFromPanel)
                controlContainer.addSubview(stopBtn)

                let restartBtn = createStyledButton(
                    title: L("Restart Bot", "봇 재시작"), width: halfWidth,
                    bgColor: NSColor.systemOrange.withAlphaComponent(0.12), fgColor: .systemOrange
                )
                restartBtn.frame = NSRect(x: halfWidth + 10, y: 0, width: halfWidth, height: 36)
                restartBtn.target = self
                restartBtn.action = #selector(restartBotFromPanel)
                controlContainer.addSubview(restartBtn)
            } else {
                let startBtn = createStyledButton(
                    title: L("Start Bot", "봇 시작"), width: contentWidth,
                    bgColor: NSColor.systemGreen.withAlphaComponent(0.15), fgColor: .systemGreen
                )
                startBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 36)
                startBtn.target = self
                startBtn.action = #selector(startBotFromPanel)
                controlContainer.addSubview(startBtn)
            }
            elements.append((controlContainer, 40))
        }

        // Settings button
        let settingsBtn = createStyledButton(
            title: L("Settings...", "설정..."), width: contentWidth,
            bgColor: NSColor.systemBlue.withAlphaComponent(0.12), fgColor: .systemBlue
        )
        settingsBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 36)
        settingsBtn.target = self
        settingsBtn.action = #selector(openSettings)
        elements.append((settingsBtn, 40))

        if hasEnv {
            // Log & Folder buttons
            let utilContainer = NSView(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 40))
            let logBtn = createStyledButton(
                title: L("View Log", "로그 보기"), width: halfWidth,
                bgColor: NSColor(white: 0.5, alpha: 0.1), fgColor: .labelColor
            )
            logBtn.frame = NSRect(x: 0, y: 0, width: halfWidth, height: 36)
            logBtn.target = self
            logBtn.action = #selector(openLog)
            utilContainer.addSubview(logBtn)

            let folderBtn = createStyledButton(
                title: L("Open Folder", "폴더 열기"), width: halfWidth,
                bgColor: NSColor(white: 0.5, alpha: 0.1), fgColor: .labelColor
            )
            folderBtn.frame = NSRect(x: halfWidth + 10, y: 0, width: halfWidth, height: 36)
            folderBtn.target = self
            folderBtn.action = #selector(openFolder)
            utilContainer.addSubview(folderBtn)

            elements.append((utilContainer, 40))
        }

        // Separator
        elements.append((createSeparator(width: contentWidth), 12))

        // Skip Permissions checkbox (dangerous)
        let skipPermsBtn = NSButton(checkboxWithTitle: L("Skip Permissions (⚠️ dangerous)", "권한 건너뛰기 (⚠️ 위험)"), target: self, action: #selector(toggleSkipPermissions))
        skipPermsBtn.state = isSkipPermissionsEnabled() ? .on : .off
        skipPermsBtn.font = NSFont.systemFont(ofSize: 12)
        elements.append((skipPermsBtn, 26))

        // Auto-start checkbox
        let autoStartBtn = NSButton(checkboxWithTitle: L("Launch on System Startup", "시스템 시작 시 자동 실행"), target: self, action: #selector(toggleAutoStart))
        autoStartBtn.state = isAutoStartEnabled() ? .on : .off
        autoStartBtn.font = NSFont.systemFont(ofSize: 12)
        elements.append((autoStartBtn, 26))

        // Update button
        if updateAvailable {
            let updateBtn = createStyledButton(
                title: L("Update Available - Click to Update", "업데이트 가능 - 클릭하여 업데이트"), width: contentWidth,
                bgColor: .systemBlue, fgColor: .white
            )
            updateBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 36)
            updateBtn.target = self
            updateBtn.action = #selector(performUpdate)
            elements.append((updateBtn, 44))
        } else {
            let checkUpdateBtn = createStyledButton(
                title: L("Check for Updates", "업데이트 확인"), width: contentWidth,
                bgColor: NSColor(white: 0.5, alpha: 0.1), fgColor: .labelColor
            )
            checkUpdateBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 36)
            checkUpdateBtn.target = self
            checkUpdateBtn.action = #selector(checkUpdateClicked)
            elements.append((checkUpdateBtn, 44))
        }

        // Separator
        elements.append((createSeparator(width: contentWidth), 12))

        // Info message
        let infoLabel = NSTextField(wrappingLabelWithString: L(
            "Closing this window does not stop the bot.\nThe bot runs in the background. Check the menu bar icon for status.",
            "이 창을 닫아도 봇은 중지되지 않습니다.\n봇은 백그라운드에서 실행됩니다. 메뉴바 아이콘에서 상태를 확인하세요."
        ))
        infoLabel.font = NSFont.systemFont(ofSize: 11)
        infoLabel.textColor = .tertiaryLabelColor
        infoLabel.preferredMaxLayoutWidth = contentWidth
        elements.append((infoLabel, 42))

        // Quit button
        let quitBtn = createStyledButton(
            title: L("Quit Bot", "봇 종료"), width: contentWidth,
            bgColor: NSColor(white: 0.5, alpha: 0.08), fgColor: .secondaryLabelColor
        )
        quitBtn.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 36)
        quitBtn.target = self
        quitBtn.action = #selector(quitAll)
        elements.append((quitBtn, 44))

        // Separator
        elements.append((createSeparator(width: contentWidth), 12))

        // GitHub link
        let ghButton = NSButton(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 20))
        ghButton.title = "GitHub: chadingTV/claudecode-discord"
        ghButton.bezelStyle = .inline
        ghButton.isBordered = false
        ghButton.font = NSFont.systemFont(ofSize: 11)
        ghButton.contentTintColor = .linkColor
        ghButton.alignment = .center
        ghButton.target = self
        ghButton.action = #selector(openGitHub)
        elements.append((ghButton, 22))

        // Issues link
        let issueButton = NSButton(frame: NSRect(x: 0, y: 0, width: contentWidth, height: 20))
        issueButton.title = L("Bug Report / Feature Request (GitHub Issues)", "버그 신고 / 기능 요청 (GitHub Issues)")
        issueButton.bezelStyle = .inline
        issueButton.isBordered = false
        issueButton.font = NSFont.systemFont(ofSize: 11)
        issueButton.contentTintColor = .linkColor
        issueButton.alignment = .center
        issueButton.target = self
        issueButton.action = #selector(openGitHubIssues)
        elements.append((issueButton, 22))

        // Star request
        let starLabel = NSTextField(labelWithString: L(
            "If you find this useful, please give it a Star on GitHub!",
            "유용하셨다면 GitHub에서 Star를 눌러주세요!"
        ))
        starLabel.font = NSFont.systemFont(ofSize: 10)
        starLabel.textColor = .tertiaryLabelColor
        starLabel.alignment = .center
        elements.append((starLabel, 20))

        // Now layout from top-down (convert to bottom-up coordinates)
        let margin: CGFloat = 25
        let topPadding: CGFloat = 15
        let spacing: CGFloat = 6

        // Calculate total content height
        var totalHeight = topPadding
        for (_, h) in elements {
            totalHeight += h + spacing
        }
        totalHeight += margin // bottom padding

        // Resize window
        var frame = window.frame
        let newHeight = max(totalHeight + 30, 400) // title bar ~30
        frame.origin.y += frame.height - newHeight
        frame.size.height = newHeight
        window.setFrame(frame, display: true)

        contentView.frame = NSRect(x: 0, y: 0, width: panelWidth, height: newHeight - 30)

        var y = contentView.frame.height - topPadding
        for (view, height) in elements {
            y -= height
            view.frame = NSRect(x: margin, y: y, width: contentWidth, height: height)
            contentView.addSubview(view)
            y -= spacing
        }

        window.contentView = contentView
    }

    // MARK: - UI Helpers

    private func createStyledButton(title: String, width: CGFloat, bgColor: NSColor, fgColor: NSColor) -> NSButton {
        let btn = NSButton(frame: NSRect(x: 0, y: 0, width: width, height: 36))
        btn.title = title
        btn.bezelStyle = .rounded
        btn.isBordered = false
        btn.wantsLayer = true
        btn.layer?.backgroundColor = bgColor.cgColor
        btn.layer?.cornerRadius = 8
        btn.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        btn.contentTintColor = fgColor
        // Hover cursor
        btn.addCursorRect(btn.bounds, cursor: .pointingHand)
        return btn
    }

    private func createLangButton(title: String, selected: Bool) -> NSButton {
        let btn = NSButton(frame: NSRect(x: 0, y: 0, width: 32, height: 22))
        btn.title = title
        btn.bezelStyle = .inline
        btn.isBordered = false
        btn.wantsLayer = true
        btn.font = NSFont.systemFont(ofSize: 11, weight: selected ? .bold : .regular)
        if selected {
            btn.contentTintColor = .white
            btn.layer?.backgroundColor = NSColor.systemBlue.cgColor
            btn.layer?.cornerRadius = 4
        } else {
            btn.contentTintColor = .secondaryLabelColor
            btn.layer?.backgroundColor = NSColor(white: 0.5, alpha: 0.1).cgColor
            btn.layer?.cornerRadius = 4
        }
        return btn
    }

    private func createSeparator(width: CGFloat) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 12))
        let sep = NSView(frame: NSRect(x: 0, y: 5, width: width, height: 1))
        sep.wantsLayer = true
        sep.layer?.backgroundColor = NSColor.separatorColor.cgColor
        container.addSubview(sep)
        return container
    }

    // MARK: - Control Panel Actions

    @objc private func startBotFromPanel() {
        startBot()
    }

    @objc private func stopBotFromPanel() {
        stopBot()
    }

    @objc private func restartBotFromPanel() {
        restartBot()
    }

    @objc private func openUsagePage() {
        NSWorkspace.shared.open(URL(string: "https://claude.ai/settings/usage")!)
    }

    @objc private func openGitHub() {
        NSWorkspace.shared.open(URL(string: "https://github.com/chadingTV/claudecode-discord")!)
    }

    @objc private func openGitHubIssues() {
        NSWorkspace.shared.open(URL(string: "https://github.com/chadingTV/claudecode-discord/issues")!)
    }

    // MARK: - Settings Window

    private func loadEnv() -> [String: String] {
        guard let content = try? String(contentsOfFile: envPath, encoding: .utf8) else { return [:] }
        var env: [String: String] = [:]
        for line in content.split(separator: "\n") {
            let str = String(line).trimmingCharacters(in: .whitespaces)
            if str.hasPrefix("#") || !str.contains("=") { continue }
            let parts = str.split(separator: "=", maxSplits: 1)
            let key = String(parts[0])
            let value = parts.count > 1 ? String(parts[1]) : ""
            env[key] = value
        }
        return env
    }

    @objc private func openSettings() {
        NSApp.activate(ignoringOtherApps: true)

        let env = loadEnv()
        let exampleValues: Set<String> = [
            "your_bot_token_here", "your_server_id_here", "your_user_id_here",
            "/Users/yourname/projects", "/Users/you/projects"
        ]

        let alert = NSAlert()
        alert.messageText = L("Claude Discord Bot Settings", "Claude Discord Bot 설정")
        alert.informativeText = L(
            "Please fill in the required fields.",
            "필수 항목을 입력해주세요."
        )
        alert.alertStyle = .informational
        alert.addButton(withTitle: L("Save", "저장"))
        alert.addButton(withTitle: L("Cancel", "취소"))

        let width: CGFloat = 400
        let fieldHeight: CGFloat = 24
        let labelHeight: CGFloat = 18
        let spacing: CGFloat = 8
        let browseButtonWidth: CGFloat = 80
        let fields: [(label: String, key: String, placeholder: String, defaultValue: String)] = [
            (L("Discord Bot Token:", "Discord 봇 토큰:"), "DISCORD_BOT_TOKEN",
             L("Paste your bot token here", "봇 토큰을 여기에 붙여넣으세요"), ""),
            (L("Discord Guild ID (Server ID):", "Discord Guild ID (서버 ID):"), "DISCORD_GUILD_ID",
             L("Right-click server > Copy Server ID", "서버 우클릭 > 서버 ID 복사"), ""),
            (L("Allowed User IDs (comma-separated):", "허용된 사용자 ID (쉼표로 구분):"), "ALLOWED_USER_IDS",
             L("e.g. 123456789,987654321", "예: 123456789,987654321"), ""),
            (L("Base Project Directory:", "기본 프로젝트 디렉토리:"), "BASE_PROJECT_DIR",
             L("e.g. /Users/you/projects", "예: /Users/you/projects"), ""),
            (L("Rate Limit Per Minute:", "분당 요청 제한:"), "RATE_LIMIT_PER_MINUTE", "10", "10"),
        ]

        // Setup guide link + fields height + Show Cost radio row
        let linkHeight: CGFloat = 20
        let noteHeight: CGFloat = 18
        let radioRowHeight: CGFloat = labelHeight + fieldHeight + spacing
        let totalHeight = (linkHeight + spacing) * 2 + CGFloat(fields.count) * (labelHeight + fieldHeight + spacing) + radioRowHeight + noteHeight + 4
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: width, height: totalHeight))

        var textFields: [String: NSTextField] = [:]
        var y = totalHeight

        // Clickable setup guide link
        y -= linkHeight
        let linkButton = NSButton(frame: NSRect(x: 0, y: y, width: width, height: linkHeight))
        linkButton.title = L("Open Setup Guide", "설정 가이드 열기")
        linkButton.bezelStyle = .inline
        linkButton.isBordered = false
        linkButton.font = NSFont.systemFont(ofSize: 12)
        linkButton.contentTintColor = .linkColor
        linkButton.target = self
        linkButton.action = #selector(openSetupGuide)
        accessory.addSubview(linkButton)

        y -= linkHeight
        let issueLink = NSButton(frame: NSRect(x: 0, y: y, width: width, height: linkHeight))
        issueLink.title = L("Bug Report / Feature Request (GitHub Issues)", "버그 신고 / 기능 요청 (GitHub Issues)")
        issueLink.bezelStyle = .inline
        issueLink.isBordered = false
        issueLink.font = NSFont.systemFont(ofSize: 12)
        issueLink.contentTintColor = .linkColor
        issueLink.target = self
        issueLink.action = #selector(openGitHubIssues)
        accessory.addSubview(issueLink)
        y -= spacing

        for field in fields {
            y -= labelHeight
            let label = NSTextField(labelWithString: field.label)
            label.frame = NSRect(x: 0, y: y, width: width, height: labelHeight)
            label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
            accessory.addSubview(label)

            y -= fieldHeight

            // Get current value, filtering out example values
            var currentValue = env[field.key] ?? ""
            if exampleValues.contains(currentValue) { currentValue = "" }

            if field.key == "BASE_PROJECT_DIR" {
                // Text field + Browse button
                let input = NSTextField(frame: NSRect(x: 0, y: y, width: width - browseButtonWidth - 4, height: fieldHeight))
                input.placeholderString = field.placeholder
                if !currentValue.isEmpty {
                    input.stringValue = currentValue
                }
                accessory.addSubview(input)
                textFields[field.key] = input

                let browseBtn = NSButton(frame: NSRect(x: width - browseButtonWidth, y: y, width: browseButtonWidth, height: fieldHeight))
                browseBtn.title = L("Browse...", "찾아보기...")
                browseBtn.bezelStyle = .rounded
                browseBtn.target = self
                browseBtn.action = #selector(browseFolderClicked(_:))
                accessory.addSubview(browseBtn)
                objc_setAssociatedObject(browseBtn, &associatedFieldKey, input, .OBJC_ASSOCIATION_RETAIN)
            } else {
                let input = NSTextField(frame: NSRect(x: 0, y: y, width: width, height: fieldHeight))
                input.placeholderString = field.placeholder

                if field.key == "DISCORD_BOT_TOKEN" && currentValue.count > 10 {
                    input.placeholderString = "****" + String(currentValue.suffix(6)) + L(" (enter full token to change)", " (변경하려면 전체 토큰 입력)")
                    input.stringValue = ""
                } else if !currentValue.isEmpty {
                    input.stringValue = currentValue
                } else if !field.defaultValue.isEmpty {
                    input.stringValue = field.defaultValue
                }

                accessory.addSubview(input)
                textFields[field.key] = input
            }

            y -= spacing
        }

        // Show Cost radio buttons
        y -= labelHeight
        let showCostLabel = NSTextField(labelWithString: L("Show Cost:", "비용 표시:"))
        showCostLabel.frame = NSRect(x: 0, y: y, width: width, height: labelHeight)
        showCostLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        accessory.addSubview(showCostLabel)

        y -= fieldHeight
        let showCostTrue = NSButton(checkboxWithTitle: L("true (show cost)", "true (비용 표시)"), target: self, action: #selector(radioToggled(_:)))
        showCostTrue.setButtonType(.radio)
        showCostTrue.frame = NSRect(x: 0, y: y, width: width / 2, height: fieldHeight)
        showCostTrue.font = NSFont.systemFont(ofSize: 12)
        showCostTrue.tag = 1001
        accessory.addSubview(showCostTrue)

        let showCostFalse = NSButton(checkboxWithTitle: L("false (Max plan)", "false (Max 요금제)"), target: self, action: #selector(radioToggled(_:)))
        showCostFalse.setButtonType(.radio)
        showCostFalse.frame = NSRect(x: width / 2, y: y, width: width / 2, height: fieldHeight)
        showCostFalse.font = NSFont.systemFont(ofSize: 12)
        showCostFalse.tag = 1002
        accessory.addSubview(showCostFalse)

        let currentShowCost = env["SHOW_COST"] ?? "true"
        if currentShowCost.lowercased() == "false" {
            showCostFalse.state = .on
            showCostTrue.state = .off
        } else {
            showCostTrue.state = .on
            showCostFalse.state = .off
        }
        y -= spacing

        // Note about Max plan
        y -= noteHeight
        let noteLabel = NSTextField(labelWithString: L(
            "* Max plan users should set Show Cost to false",
            "* Max 요금제 사용자는 Show Cost를 false로 설정하세요"
        ))
        noteLabel.frame = NSRect(x: 0, y: y, width: width, height: noteHeight)
        noteLabel.font = NSFont.systemFont(ofSize: 10)
        noteLabel.textColor = .secondaryLabelColor
        accessory.addSubview(noteLabel)

        alert.accessoryView = accessory

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            var newEnv: [String: String] = [:]
            for field in fields {
                let value = textFields[field.key]?.stringValue ?? ""
                if field.key == "DISCORD_BOT_TOKEN" && value.isEmpty {
                    newEnv[field.key] = env[field.key] ?? ""
                } else if value.isEmpty {
                    newEnv[field.key] = field.defaultValue
                } else {
                    newEnv[field.key] = value
                }
            }
            newEnv["SHOW_COST"] = showCostTrue.state == .on ? "true" : "false"

            // 필수 체크
            if (newEnv["DISCORD_BOT_TOKEN"] ?? "").isEmpty ||
               (newEnv["DISCORD_GUILD_ID"] ?? "").isEmpty ||
               (newEnv["ALLOWED_USER_IDS"] ?? "").isEmpty {
                let errAlert = NSAlert()
                errAlert.messageText = L("Required Fields Missing", "필수 항목 누락")
                errAlert.informativeText = L(
                    "Bot Token, Guild ID (Server ID), and User IDs are required.",
                    "Bot Token, Guild ID (서버 ID), User IDs는 필수 항목입니다."
                )
                errAlert.alertStyle = .warning
                errAlert.runModal()
                return
            }

            // .env 파일 쓰기
            var content = ""
            for field in fields {
                content += "\(field.key)=\(newEnv[field.key] ?? "")\n"
            }
            content += "# Show estimated API cost in task results (set false for Max plan users)\n"
            content += "SHOW_COST=\(newEnv["SHOW_COST"] ?? "true")\n"
            try? content.write(toFile: envPath, atomically: true, encoding: .utf8)

            updateStatus()
            buildMenu()
            rebuildControlPanel()

            // Auto-start bot if not running and env is configured
            if !isRunning() && isEnvConfigured() {
                startBot()
            }
        }
    }

    @objc private func openSetupGuide() {
        NSWorkspace.shared.open(URL(string: "https://github.com/chadingTV/claudecode-discord/blob/main/SETUP.md")!)
    }

    @objc private func radioToggled(_ sender: NSButton) {
        guard let parent = sender.superview else { return }
        for case let btn as NSButton in parent.subviews where btn.tag == 1001 || btn.tag == 1002 {
            btn.state = (btn === sender) ? .on : .off
        }
    }

    @objc private func browseFolderClicked(_ sender: NSButton) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = L("Select", "선택")
        panel.message = L("Select Base Project Directory", "기본 프로젝트 디렉토리 선택")
        if panel.runModal() == .OK, let url = panel.url {
            if let field = objc_getAssociatedObject(sender, &associatedFieldKey) as? NSTextField {
                field.stringValue = url.path
            }
        }
    }

    @objc private func toggleAutoStart() {
        if isAutoStartEnabled() {
            // Disable: remove menubar autostart plist
            runShell("launchctl unload '\(menubarPlistDst)' 2>/dev/null")
            try? FileManager.default.removeItem(atPath: menubarPlistDst)
        } else {
            // Enable: register menubar app to launch on login
            // (menubar app auto-starts bot when it launches)
            generateMenubarPlist()
            runShell("launchctl load '\(menubarPlistDst)'")
        }
        buildMenu()
        rebuildControlPanel()
    }

    private func isSkipPermissionsEnabled() -> Bool {
        guard let contents = try? String(contentsOfFile: skipPermsFile, encoding: .utf8) else {
            return false
        }
        return contents.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    @objc private func toggleSkipPermissions() {
        let currentlyOn = isSkipPermissionsEnabled()
        if !currentlyOn {
            // Confirm only when turning ON (false → true).
            let alert = NSAlert()
            alert.messageText = L("Enable Skip Permissions?",
                                  "권한 건너뛰기를 활성화하시겠습니까?")
            alert.informativeText = L(
                "Skip Permissions lets Claude run any tool — including file writes, shell commands, and network calls — without confirmation. Continue?",
                "권한 건너뛰기를 켜면 Claude가 파일 쓰기, 셸 명령, 네트워크 호출을 포함한 모든 도구를 확인 없이 실행합니다. 계속할까요?"
            )
            alert.alertStyle = .warning
            alert.addButton(withTitle: L("Cancel", "취소"))
            alert.addButton(withTitle: L("Enable", "활성화"))
            let response = alert.runModal()
            // First button (Cancel) → .alertFirstButtonReturn
            // Second button (Enable) → .alertSecondButtonReturn
            guard response == .alertSecondButtonReturn else { return }
            writeSkipPermsFlag(true)
        } else {
            writeSkipPermsFlag(false)
        }
        buildMenu()
        rebuildControlPanel()
    }

    private func writeSkipPermsFlag(_ enabled: Bool) {
        let content = enabled ? "true" : "false"
        try? content.write(toFile: skipPermsFile, atomically: true, encoding: .utf8)
    }

    private func isAutoStartEnabled() -> Bool {
        return FileManager.default.fileExists(atPath: menubarPlistDst)
    }

    private func generateMenubarPlist() {
        let menubarBin = "\(botDir)/menubar/ClaudeBotMenu"
        let content = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>\(menubarLabel)</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(menubarBin)</string>
            </array>
            <key>WorkingDirectory</key>
            <string>\(botDir)</string>
            <key>RunAtLoad</key>
            <true/>
            <key>StandardOutPath</key>
            <string>/dev/null</string>
            <key>StandardErrorPath</key>
            <string>/dev/null</string>
        </dict>
        </plist>
        """
        try? content.write(toFile: menubarPlistDst, atomically: true, encoding: .utf8)
    }

    // MARK: - Plist Generation

    /// Migrate from old launchd-managed bot to panel-managed bot.
    /// Removes the old com.claude-discord.plist so launchd won't auto-start the bot at boot.
    private func migrateAwayFromBotPlist() {
        let uid = runShell("id -u").trimmingCharacters(in: .whitespacesAndNewlines)
        if FileManager.default.fileExists(atPath: plistDst) {
            NSLog("[ClaudeBotMenu] migration: removing legacy bot plist at \(plistDst)")
            runShell("""
                launchctl bootout gui/\(uid)/\(label) 2>/dev/null
                launchctl unload '\(plistDst)' 2>/dev/null
                launchctl remove \(label) 2>/dev/null
            """)
            try? FileManager.default.removeItem(atPath: plistDst)
        }
        // Kill any leftover bot the old launchd might have spawned
        runShell("pkill -KILL -f 'node dist/index.js' 2>/dev/null")
    }

    // MARK: - Bot Controls

    @objc private func startBot() {
        NSLog("[ClaudeBotMenu] startBot() called")
        if let p = botProcess, p.isRunning {
            NSLog("[ClaudeBotMenu] bot already running, ignoring start")
            return
        }

        // Defensive: kill any orphan node that might be left from prior crash
        runShell("pkill -KILL -f 'node dist/index.js' 2>/dev/null; rm -f '\(botDir)/.bot.lock'")

        // Open log files for the child process
        let outLogPath = "\(botDir)/bot.log"
        let errLogPath = "\(botDir)/bot-error.log"
        if !FileManager.default.fileExists(atPath: outLogPath) {
            FileManager.default.createFile(atPath: outLogPath, contents: nil)
        }
        if !FileManager.default.fileExists(atPath: errLogPath) {
            FileManager.default.createFile(atPath: errLogPath, contents: nil)
        }

        let process = Process()
        process.launchPath = "/bin/bash"
        process.arguments = ["\(botDir)/mac-start.sh", "--fg"]
        process.currentDirectoryPath = botDir
        if let outHandle = FileHandle(forWritingAtPath: outLogPath) {
            outHandle.seekToEndOfFile()
            process.standardOutput = outHandle
        }
        if let errHandle = FileHandle(forWritingAtPath: errLogPath) {
            errHandle.seekToEndOfFile()
            process.standardError = errHandle
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.botProcess = nil
                self?.updateStatus()
                self?.buildMenu()
                self?.rebuildControlPanel()
            }
        }

        do {
            try process.run()
            botProcess = process
            NSLog("[ClaudeBotMenu] bot spawned, pid=\(process.processIdentifier)")
        } catch {
            NSLog("[ClaudeBotMenu] failed to spawn bot: \(error)")
            botProcess = nil
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.updateStatus()
            self.buildMenu()
            self.rebuildControlPanel()
        }
    }

    @objc private func stopBot() {
        NSLog("[ClaudeBotMenu] stopBot() called")
        let process = botProcess
        botProcess = nil  // immediately reflect intent so isRunning() returns false

        if let p = process, p.isRunning {
            p.terminate()  // SIGTERM
        }

        // Background: wait briefly, then SIGKILL any leftover, plus clean lock
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<8 {
                if !(process?.isRunning ?? false) { break }
                Thread.sleep(forTimeInterval: 0.2)
            }
            self.runShell("pkill -KILL -f 'node dist/index.js' 2>/dev/null; rm -f '\(self.botDir)/.bot.lock'")
        }

        updateStatus()
        buildMenu()
        rebuildControlPanel()
        controlPanel?.displayIfNeeded()
    }

    @objc private func restartBot() {
        stopBot()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.startBot()
        }
    }

    @objc private func openLog() {
        let logPath = "\(botDir)/bot.log"
        let errLogPath = "\(botDir)/bot-error.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        let cmd = "echo \\\"=== bot-error.log ===\\\" && tail -20 \\\"" + errLogPath + "\\\" 2>/dev/null; echo \\\"\\\"; echo \\\"=== bot.log (live) ===\\\" && tail -100f \\\"" + logPath + "\\\""
        runShell("osascript -e 'tell application \"Terminal\" to do script \"\(cmd)\"'")
    }

    @objc private func openFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: botDir))
    }

    @objc private func quitAll() {
        stopBot()
        // Give stopBot time to send SIGTERM
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.runShell("pkill -KILL -f 'node dist/index.js' 2>/dev/null; rm -f '\(self.botDir)/.bot.lock'")
            NSApplication.shared.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Bot is the panel's child — kill it on exit
        if let p = botProcess, p.isRunning {
            p.terminate()
        }
        runShell("pkill -KILL -f 'node dist/index.js' 2>/dev/null; rm -f '\(botDir)/.bot.lock'")
    }

    @discardableResult
    private func runShell(_ command: String) -> String {
        let task = Process()
        task.launchPath = "/bin/bash"
        task.arguments = ["-c", command]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        try? task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - Status Dot View

// MARK: - Claude Usage Data Model

struct ClaudeUsageTier {
    let utilization: Double // 0.0 ~ 1.0
    let resetsAt: String?
}

struct ClaudeUsageData {
    var fiveHour: ClaudeUsageTier?
    var sevenDay: ClaudeUsageTier?
    var sevenDaySonnet: ClaudeUsageTier?
}

class StatusDot: NSView {
    var color: NSColor

    init(color: NSColor) {
        self.color = color
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) {
        self.color = .systemGreen
        super.init(coder: coder)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let path = NSBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2))
        color.setFill()
        path.fill()
    }
}

// MARK: - App Entry Point

// Kill any existing ClaudeBotMenu instances (prevent duplicates)
let myPid = ProcessInfo.processInfo.processIdentifier
let runningApps = NSWorkspace.shared.runningApplications
for app in runningApps {
    if let name = app.executableURL?.lastPathComponent, name == "ClaudeBotMenu",
       app.processIdentifier != myPid {
        app.terminate()
    }
}
// Also pkill in case NSWorkspace doesn't catch all
let killTask = Process()
killTask.launchPath = "/bin/bash"
killTask.arguments = ["-c", "pgrep -f ClaudeBotMenu | grep -v \(myPid) | xargs kill 2>/dev/null"]
try? killTask.run()
killTask.waitUntilExit()
Thread.sleep(forTimeInterval: 0.3)

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
