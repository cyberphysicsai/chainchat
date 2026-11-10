import AppKit

final class Setup: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 640, height: 390),
        styleMask: [.titled, .closable, .miniaturizable],
        backing: .buffered, defer: false)
    private let status = NSTextField(wrappingLabelWithString: "Set up ChainChat for this user. The installer opens the browser setup guide when it finishes.")
    private let progress = NSTextView()
    private let start = NSButton(title: "Install ChainChat", target: nil, action: nil)
    private var process: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "ChainChat Setup"
        window.delegate = self
        window.center()
        start.target = self
        start.action = #selector(install)
        start.bezelStyle = .rounded
        progress.isEditable = false
        progress.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        let scroll = NSScrollView()
        scroll.documentView = progress
        scroll.hasVerticalScroller = true
        let stack = NSStackView(views: [status, scroll, start])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let content = window.contentView else { return }
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func install() {
        guard process == nil, let script = Bundle.main.url(forResource: "install", withExtension: "sh") else {
            status.stringValue = "The setup resource is missing. Download ChainChat again."
            return
        }
        let task = Process()
        let output = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = [script.path]
        task.environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("CT_") }
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async {
                guard let view = self?.progress, let storage = view.textStorage else { return }
                storage.append(NSAttributedString(string: text))
                view.scrollToEndOfDocument(nil)
            }
        }
        task.terminationHandler = { [weak self] result in
            let succeeded = result.terminationStatus == 0
            DispatchQueue.main.async {
                self?.process = nil
                self?.status.stringValue = succeeded
                    ? "Installation finished. Continue in the ChainChat browser setup guide."
                    : "Setup could not finish. Review the details and try again."
                self?.start.isEnabled = !succeeded
            }
        }
        progress.string = ""
        start.isEnabled = false
        status.stringValue = "Installing ChainChat…"
        process = task
        do { try task.run() }
        catch {
            output.fileHandleForReading.readabilityHandler = nil
            process = nil
            start.isEnabled = true
            status.stringValue = "The installation process could not start."
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { process == nil }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        process == nil ? .terminateNow : .terminateCancel
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let setup = Setup()
app.setActivationPolicy(.regular)
app.delegate = setup
app.run()
