import Foundation

#if canImport(AppKit)
import AppKit

// MARK: - SleepWakeMonitor

/// Observes macOS sleep/wake events via NSWorkspace notifications and invokes
/// caller-provided callbacks on each transition.
///
/// NSWorkspace notifications are delivered on the main thread, which is fine
/// because the daemon runs `RunLoop.main.run()` in production.
///
/// Usage:
/// ```swift
/// let monitor = SleepWakeMonitor(
///     onSleep: { /* pause automation, flush IPC, clear cache */ },
///     onWake:  { /* verify Safari connection, resume automation */ }
/// )
/// monitor.start()
/// ```
public final class SleepWakeMonitor: @unchecked Sendable {

    // MARK: Callbacks

    /// Called when the system is about to sleep. Runs on the main thread.
    public var onSleep: (() -> Void)?

    /// Called when the system wakes from sleep. Runs on the main thread.
    public var onWake: (() -> Void)?

    // MARK: State

    private var sleepObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private(set) public var isRunning: Bool = false

    // MARK: Init

    public init(onSleep: (() -> Void)? = nil, onWake: (() -> Void)? = nil) {
        self.onSleep = onSleep
        self.onWake = onWake
    }

    deinit {
        stop()
    }

    // MARK: Public API

    /// Begin observing sleep/wake notifications.
    /// Safe to call multiple times — subsequent calls are no-ops while running.
    public func start() {
        guard !isRunning else { return }
        isRunning = true

        let center = NSWorkspace.shared.notificationCenter

        sleepObserver = center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleSleep()
        }

        wakeObserver = center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleWake()
        }

        Logger.info("SleepWakeMonitor: started — observing sleep/wake notifications")
    }

    /// Stop observing notifications and release resources.
    public func stop() {
        guard isRunning else { return }
        isRunning = false

        let center = NSWorkspace.shared.notificationCenter
        if let obs = sleepObserver { center.removeObserver(obs) }
        if let obs = wakeObserver  { center.removeObserver(obs) }
        sleepObserver = nil
        wakeObserver = nil

        Logger.info("SleepWakeMonitor: stopped")
    }

    // MARK: Event Handlers

    private func handleSleep() {
        Logger.info("SleepWakeMonitor: system going to sleep — pausing automation")
        onSleep?()
    }

    private func handleWake() {
        Logger.info("SleepWakeMonitor: system woke from sleep — resuming automation")
        onWake?()
    }
}

#else

// MARK: - Stub for non-AppKit platforms (Linux CI / SwiftPM on non-macOS)

public final class SleepWakeMonitor: @unchecked Sendable {
    public var onSleep: (() -> Void)?
    public var onWake:  (() -> Void)?
    private(set) public var isRunning: Bool = false

    public init(onSleep: (() -> Void)? = nil, onWake: (() -> Void)? = nil) {
        self.onSleep = onSleep
        self.onWake  = onWake
    }

    public func start() { isRunning = true  }
    public func stop()  { isRunning = false }
}

#endif
