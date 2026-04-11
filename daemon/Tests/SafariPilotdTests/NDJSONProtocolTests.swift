import Foundation
import SafariPilotdCore

// MARK: - Minimal test harness (no XCTest — CLT-only environment)

var passed = 0
var failed = 0

func test(_ name: String, body: () throws -> Void) {
    do {
        try body()
        print("  PASS  \(name)")
        passed += 1
    } catch {
        print("  FAIL  \(name): \(error)")
        failed += 1
    }
}

func assertEqual<T: Equatable>(_ a: T, _ b: T, _ msg: String = "") throws {
    guard a == b else {
        throw TestFailure("Expected \(a) == \(b)\(msg.isEmpty ? "" : " — \(msg)")")
    }
}

func assertTrue(_ condition: Bool, _ msg: String = "") throws {
    guard condition else { throw TestFailure("Expected true\(msg.isEmpty ? "" : " — \(msg)")") }
}

func assertFalse(_ condition: Bool, _ msg: String = "") throws {
    guard !condition else { throw TestFailure("Expected false\(msg.isEmpty ? "" : " — \(msg)")") }
}

func assertThrows<T>(_ body: () throws -> T, matching match: (Error) -> Bool = { _ in true }, _ msg: String = "") throws {
    do {
        _ = try body()
        throw TestFailure("Expected a throw but no error was thrown\(msg.isEmpty ? "" : " — \(msg)")")
    } catch let e where !(e is TestFailure) {
        guard match(e) else {
            throw TestFailure("Thrown error \(e) did not match expected type\(msg.isEmpty ? "" : " — \(msg)")")
        }
    }
}

struct TestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ msg: String) { description = msg }
}

// MARK: - Tests

print("SafariPilotdTests")
print("-----------------")

// 1. testParseCommand
test("testParseCommand") {
    let line = #"{"id":"cmd-1","method":"navigate","params":{"url":"https://example.com","timeout":5000}}"#
    let command = try NDJSONParser.parseCommand(line: line)
    try assertEqual(command.id, "cmd-1")
    try assertEqual(command.method, "navigate")
    try assertEqual(command.params["url"]?.value as? String, "https://example.com")
    try assertEqual(command.params["timeout"]?.value as? Int, 5000)
}

// 2. testParsePingCommand
test("testParsePingCommand") {
    let line = #"{"id":"ping-1","method":"ping"}"#
    let command = try NDJSONParser.parseCommand(line: line)
    try assertEqual(command.id, "ping-1")
    try assertEqual(command.method, "ping")
    try assertTrue(command.params.isEmpty)
}

// 3. testSerializeSuccessResponse
test("testSerializeSuccessResponse") {
    let response = Response.success(
        id: "cmd-1",
        value: AnyCodable(["title": "Example Domain"]),
        elapsedMs: 42.5
    )
    let line = try NDJSONSerializer.serialize(response: response)
    try assertFalse(line.contains("\n"), "Serialized response must not contain newlines")

    let data = line.data(using: .utf8)!
    let parsed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    try assertEqual(parsed["id"] as? String, "cmd-1")
    try assertEqual(parsed["ok"] as? Bool, true)
    try assertEqual(parsed["elapsedMs"] as? Double, 42.5)
    try assertTrue(parsed["value"] != nil)
}

// 4. testSerializeErrorResponse
test("testSerializeErrorResponse") {
    let structuredError = StructuredError(
        code: "NAVIGATION_FAILED",
        message: "Page load timed out",
        retryable: true
    )
    let response = Response.failure(id: "cmd-2", error: structuredError, elapsedMs: 5000)
    let line = try NDJSONSerializer.serialize(response: response)
    try assertFalse(line.contains("\n"), "Error response must not contain newlines")

    let data = line.data(using: .utf8)!
    let parsed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    try assertEqual(parsed["id"] as? String, "cmd-2")
    try assertEqual(parsed["ok"] as? Bool, false)

    let errorDict = parsed["error"] as! [String: Any]
    try assertEqual(errorDict["code"] as? String, "NAVIGATION_FAILED")
    try assertEqual(errorDict["message"] as? String, "Page load timed out")
    try assertEqual(errorDict["retryable"] as? Bool, true)
}

// 5. testRejectsInvalidJSON
test("testRejectsInvalidJSON") {
    try assertThrows({ try NDJSONParser.parseCommand(line: "this is not json at all !@#$") },
        matching: { if case NDJSONError.invalidJSON = $0 { return true }; return false },
        "Expected NDJSONError.invalidJSON")
}

// 6. testRejectsEmptyID
test("testRejectsEmptyID") {
    let line = #"{"id":"","method":"ping"}"#
    try assertThrows({ try NDJSONParser.parseCommand(line: line) },
        matching: { if case NDJSONError.emptyID = $0 { return true }; return false },
        "Expected NDJSONError.emptyID")
}

// MARK: - Results

print("-----------------")
print("Results: \(passed) passed, \(failed) failed")
if failed > 0 {
    exit(1)
}
