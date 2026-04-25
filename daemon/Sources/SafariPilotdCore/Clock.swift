import Foundation

/// Time-source abstraction for testability.
///
/// Production code injects `SystemTimeSource` (returns `Date()`); tests can
/// inject a controllable mock to exercise time-dependent branches without
/// sleeping. Named `TimeSource` rather than `Clock` to avoid collision with
/// Swift's built-in `Clock` protocol from macOS 13+.
///
/// SD-23 introduced this for HealthStore's `pruneStaleSessionsLocked` cutoff
/// transition. SD-28 will extend the same protocol to ExtensionBridge's
/// executedLog TTL and ExtensionHTTPServer's disconnect-detection threshold,
/// which currently use `*ForTest` test-only public methods.
public protocol TimeSource: Sendable {
    func now() -> Date
}

/// Production default — wraps `Date()` directly.
public struct SystemTimeSource: TimeSource {
    public init() {}
    public func now() -> Date { Date() }
}
