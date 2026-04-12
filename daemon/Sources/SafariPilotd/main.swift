import Foundation
import SafariPilotdCore

#if canImport(AppKit)
import AppKit
#endif

// MARK: - Version

private let version = "0.1.2"

// MARK: - Signal handling

/// Register a SIGTERM handler so launchd / kill can shut the daemon down cleanly.
/// We use a DispatchSource because signal handlers have severe restrictions —
/// only async-signal-safe functions are permitted inside them.
private func installSIGTERMHandler() {
    signal(SIGTERM, SIG_IGN) // Disable default handler; DispatchSource takes over.

    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
        Logger.info("SafariPilotd: SIGTERM received — shutting down cleanly")
        exit(0)
    }
    source.resume()
    // Keep source alive for the lifetime of the process.
    _ = Unmanaged.passRetained(source as AnyObject)
}

// MARK: - Command-line Argument Parsing

private func parseArgs() {
    let args = CommandLine.arguments.dropFirst() // skip binary name

    if args.contains("--version") {
        print("SafariPilotd \(version)")
        exit(0)
    }

    if args.contains("--check") {
        runHealthCheck()
        // runHealthCheck calls exit() before returning.
    }
}

// MARK: - Health Check Mode

/// Verify that Safari is reachable via AppleScript, print status, then exit.
private func runHealthCheck() {
    Logger.info("SafariPilotd --check: running health check")

    let executor = AppleScriptExecutor()
    // A benign AppleScript that simply returns Safari's name — works even when
    // no window is open.  We use a semaphore to bridge the async call into the
    // synchronous check mode.
    let script = #"tell application "Safari" to return name"#

    let semaphore = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var checkResponse: Response?

    Task {
        checkResponse = await executor.execute(script: script, commandID: "health-check")
        semaphore.signal()
    }
    semaphore.wait()

    if let response = checkResponse, response.ok {
        print("OK: Safari is accessible")
        Logger.info("SafariPilotd --check: OK")
        exit(0)
    } else {
        let code = checkResponse?.error?.code ?? "UNKNOWN"
        let msg  = checkResponse?.error?.message ?? "no response"
        print("FAIL: \(code) — \(msg)")
        Logger.error("SafariPilotd --check: FAIL — \(code): \(msg)")
        exit(1)
    }
}

// MARK: - Entry Point

parseArgs()

Logger.info("SafariPilotd \(version) starting")

// 1. Core AppleScript executor (LRU cache built-in).
let executor = AppleScriptExecutor()

// 2. Sleep/Wake monitor — clear the compiled-script cache when the system
//    sleeps so we start fresh after wake (Safari may have been quit/restarted).
let sleepWakeMonitor = SleepWakeMonitor(
    onSleep: {
        Logger.info("SafariPilotd: system sleeping — clearing AppleScript cache")
        executor.clearCache()
    },
    onWake: {
        Logger.info("SafariPilotd: system woke — ready to resume automation")
    }
)
sleepWakeMonitor.start()

// 3. Memory watchdog — evict the cache when RSS exceeds 100 MB.
//    Checked every 100 commands inside the dispatch loop via the commandCount
//    counter below.
let watchdog = MemoryWatchdog(thresholdMB: 100) {
    Logger.warning("SafariPilotd: memory threshold exceeded — clearing AppleScript cache")
    executor.clearCache()
}

// 4. Safari crash-recovery wrapper around the executor.
let recovery = SafariRecovery()

// 5. Recovery-aware executor adapter: wraps ScriptExecutorProtocol so the
//    dispatcher uses recovery logic transparently, and bumps the command counter
//    so the watchdog check fires every 100 commands.
final class RecoveryExecutor: ScriptExecutorProtocol, @unchecked Sendable {
    private let inner: AppleScriptExecutor
    private let recovery: SafariRecovery
    private let watchdog: MemoryWatchdog
    private var commandCount = 0

    init(inner: AppleScriptExecutor, recovery: SafariRecovery, watchdog: MemoryWatchdog) {
        self.inner = inner
        self.recovery = recovery
        self.watchdog = watchdog
    }

    func execute(script: String, commandID: String) async -> Response {
        commandCount += 1
        if commandCount % 100 == 0 {
            watchdog.checkMemory()
        }
        return await recovery.executeWithRecovery(
            executor: inner,
            script: script,
            commandID: commandID
        )
    }
}

let recoveryExecutor = RecoveryExecutor(inner: executor, recovery: recovery, watchdog: watchdog)

// 6. Command dispatcher — reads NDJSON from stdin, routes commands, writes
//    NDJSON responses to stdout.
let dispatcher = CommandDispatcher(executor: recoveryExecutor)

// Install SIGTERM handler before entering the run loop.
installSIGTERMHandler()

Logger.info("SafariPilotd: entering run loop — listening on stdin")

// Start the dispatcher on a background Task so it doesn't block the main thread.
// The main thread runs RunLoop.main.run() which is required for:
//   - NSWorkspace notifications (SleepWakeMonitor)
//   - NSAppleScript (must run on main thread)
Task {
    await dispatcher.run()
    // dispatcher.run() only returns when stdin is closed.
    Logger.info("SafariPilotd: stdin closed — exiting")
    exit(0)
}

RunLoop.main.run()
