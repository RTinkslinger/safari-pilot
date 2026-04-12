# Executive Summary

Implementing a robust Safari testing strategy on CI infrastructure requires navigating macOS-specific security constraints and choosing between two primary approaches: high-fidelity testing with the actual Safari browser or high-efficiency testing with the WebKit engine. As of early 2026, GitHub Actions provides `macos-14` and `macos-15` runners, with `macos-latest` aliased to `macos-15`. Pinning to a specific version like `macos-15` is crucial for build stability.

The most significant challenge is non-interactively enabling permissions. Automation with `safaridriver` requires enabling 'Allow Remote Automation' and granting Accessibility/Apple Events permissions. While the `sudo safaridriver --enable` command handles part of the setup, full automation on hosted CI runners is often unreliable due to security features like TCC and SIP. The most dependable solution, particularly for self-hosted runners, involves pre-configuring a macOS image with a mobile configuration profile (MDM) to grant permissions and using a one-time script to enable UI settings.

Key Recommendations:
1.  **Adopt a Hybrid Testing Strategy**: Use Playwright with its WebKit engine for the majority of tests. It offers excellent parallelism, reliable headless execution, and simpler CI setup, bypassing most macOS permission issues. Reserve a smaller, critical suite of tests to run against the actual Safari browser using `safaridriver` (with Selenium or WebdriverIO) to validate Safari-specific behaviors and integrations.
2.  **Manage CI Runners Effectively**: On GitHub Actions, pin your workflows to a specific version (e.g., `runs-on: macos-15`) to prevent unexpected breakages from OS or Safari updates. For `safaridriver` tests, true parallelism can only be achieved by scaling out with multiple macOS runner jobs, as `safaridriver` is limited to one UI session per machine.
3.  **Standardize Setup and Reporting**: In your CI workflow, include a setup step to run `sudo /usr/bin/safaridriver --enable`. For self-hosted runners, invest in creating a pre-configured machine image. Standardize on JUnit XML for test reporting to ensure compatibility with CI dashboards, and configure your test runner to capture screenshots and traces on failure, uploading them as build artifacts for easier debugging.
4.  **Acknowledge Headless Limitations**: Native headless testing with `safaridriver` is not supported. All headless testing must be performed using Playwright's WebKit. Any test requiring the true Safari browser environment will necessitate a full GUI session on a macOS runner.

# Ci Runner Specifications

## Platform

GitHub Actions

## Image Name

macos-latest

## Operating System

macOS 15

## Included Safari Version

The version of Safari bundled with macOS 15.

## Safaridriver Availability

Pre-installed at `/usr/bin/safaridriver`. Implements the W3C WebDriver protocol.

## Notes

As of 2025/2026, this label points to the `macos-15` image. It is recommended to pin to a specific version (e.g., `macos-15`) to ensure workflow stability and prevent unexpected updates.

## Platform

GitHub Actions

## Image Name

macos-15

## Operating System

macOS 15

## Included Safari Version

The version of Safari bundled with macOS 15.

## Safaridriver Availability

Pre-installed at `/usr/bin/safaridriver`. Implements the W3C WebDriver protocol.

## Notes

This is the current latest stable macOS runner image. It includes a logged-in GUI session, which is a prerequisite for running `safaridriver` tests.

## Platform

GitHub Actions

## Image Name

macos-14

## Operating System

macOS 14

## Included Safari Version

The version of Safari bundled with macOS 14.

## Safaridriver Availability

Pre-installed at `/usr/bin/safaridriver`. Implements the W3C WebDriver protocol.

## Notes

This is the previous version of the macOS runner. It can be used to test against an older Safari/macOS combination.

## Platform

CircleCI

## Image Name

macOS Images

## Operating System

Varies

## Included Safari Version

Varies with the selected macOS/Xcode image.

## Safaridriver Availability

Available on macOS images, but specific versions are tied to the image.

## Notes

The provided research did not contain specific details on CircleCI's macOS image contents. However, it notes that hosted macOS workers have similar system-level restrictions to GitHub Actions. For full control over permissions and environment setup, using a self-hosted macOS executor is the recommended best practice.

## Platform

Buildkite

## Image Name

Self-hosted

## Operating System

User-defined

## Included Safari Version

User-defined

## Safaridriver Availability

User-defined

## Notes

The provided research indicates that Buildkite is typically used with self-hosted macOS agents. This gives users complete administrative control to create a custom macOS image with all necessary permissions, settings, and software pre-configured, which is the most reliable method for running Safari tests.


# Safari Permission Automation Guide

Automating Safari on CI requires non-interactively configuring several permissions due to macOS's security architecture (System Integrity Protection - SIP, and Transparency, Consent, and Control - TCC). The two primary requirements are enabling 'Allow Remote Automation' and granting the test process permissions for Accessibility and Apple Events.

### 1. Enabling the Develop Menu and 'Allow Remote Automation'

This setting is required for `safaridriver` to control the browser.

*   **Recommended Command**: The primary non-interactive step is to run `safaridriver` with the `--enable` flag. This command requires administrator privileges and should be executed once per machine in your CI setup script.
    ```bash
    sudo safaridriver --enable
    ```
    This command attempts to configure the system, but it may not be sufficient on its own if the UI setting is not toggled.

*   **AppleScript (Fragile Workaround)**: On modern macOS, the old `defaults write com.apple.Safari AllowRemoteAutomation` command no longer works. The only programmatic way to toggle the UI checkbox is via GUI scripting with AppleScript. This is fragile as it depends on UI element names and requires an active GUI session.
    ```applescript
    # This script requires Accessibility permissions for the process executing it (e.g., osascript)
    tell application "System Events"
        tell process "Safari"
            set frontmost to true
            # Ensure Develop menu is visible first (may need separate script for Preferences)
            click menu item "Allow Remote Automation" of menu "Develop" of menu bar 1
        end tell
    end tell
    ```

*   **Verification**: You can check the status by running:
    ```bash
    safaridriver --diagnose
    ```

### 2. Granting TCC Permissions (Accessibility & Apple Events)

Any process that programmatically controls another application's UI needs user consent, which is managed by the TCC framework.

*   **Configuration Profiles (MDM) - Recommended Method**: This is the only Apple-supported and reliable way to pre-approve TCC permissions without user interaction or disabling SIP. You create a `.mobileconfig` file that specifies the bundle IDs (e.g., `com.apple.safaridriver`, `com.apple.Terminal`) to be granted `kTCCServiceAccessibility` and `kTCCServiceAppleEvents` permissions. This profile can be installed on self-hosted CI runners using the `profiles` command-line tool.

*   **Direct TCC.db Edits - Not Recommended**: Manually modifying the TCC database (`/Library/Application Support/com.apple.TCC/TCC.db`) with `sqlite3` is blocked by SIP on modern macOS. This method is obsolete and should not be used on production or hosted CI systems.

*   **`tccutil` Command**: The `tccutil` tool can only be used to *reset* permissions for an application, not to grant them. It is not useful for pre-authorizing access.

### Recommended Workflow by Environment

*   **Hosted CI Runners (GitHub Actions, CircleCI)**:
    1.  These environments are highly restrictive. You cannot install configuration profiles or disable SIP.
    2.  Your only option is to rely on the `sudo safaridriver --enable` command and hope the base runner image has the necessary UI settings pre-configured (which is often the case for GitHub's `macos` images).
    3.  If tests remain flaky due to permission issues, the most practical solution is to switch to **Playwright's WebKit in headless mode**, which bypasses all of these GUI and TCC requirements.

*   **Self-Hosted CI Runners (Buildkite, self-hosted GitHub/CircleCI)**:
    1.  This environment offers full control and is the most reliable for `safaridriver` testing.
    2.  **Create a golden macOS image**: On a master machine, install a configuration profile (`.mobileconfig`) that grants Accessibility and Apple Events permissions to `safaridriver` and any other required tools.
    3.  **Enable Auto-Login**: Configure the user account to log in automatically on boot to ensure an active GUI session is always available.
    4.  **Run One-Time Setup**: As part of the image creation, run `sudo safaridriver --enable` and any necessary AppleScripts to toggle UI settings permanently.
    5.  Use this pre-configured image for all your CI agents. This 'bakes in' the permissions, leading to fast and reliable test execution.

# Testing Framework Comparison

## Framework

Selenium + safaridriver

## Primary Use Case

This approach is ideal for high-fidelity testing that requires strict compliance with the behavior of the actual, branded Safari.app. It should be used when verifying features specific to Apple's browser, such as unique rendering behaviors, Apple-specific integrations (like ITP - Intelligent Tracking Prevention), or when the test scope explicitly demands validation against the real user-facing application rather than just the underlying engine. It is the go-to choice for final regression testing on the true Safari browser.

## Headless Support

Native Safari via `safaridriver` does not support a true or reliable headless mode. Test execution requires an active macOS GUI session because `safaridriver` automates the Safari application itself, which needs a window server to run. The alternative, Playwright's WebKit, offers robust headless execution by automating its own engine build directly, bypassing the need for the Safari app and a GUI.

## Parallelism Strategy

Parallelism is severely limited. The `safaridriver` supports only a single active session per macOS user profile. Therefore, to run tests in parallel, one must scale horizontally by using multiple independent macOS CI runners (e.g., multiple `macos-15` jobs in a GitHub Actions matrix). This increases infrastructure costs and complexity. In contrast, Playwright's WebKit supports efficient parallelism on a single machine through its built-in test sharding and worker model.

## Reliability Notes

Common flakiness patterns stem from its single-instance constraint, the requirement for 'Allow Remote Automation' to be enabled in Safari's Develop menu, and potential permission dialogs if the driver is not pre-authorized. Timing-related timeouts are also frequent. Mitigation strategies include: running `sudo safaridriver --enable` and executing `/usr/bin/safaridriver` once as a setup step in CI to grant permissions, ensuring tests are serialized on a single runner, implementing robust explicit waits and retries, and pinning the macOS runner version (e.g., `macos-15`) to prevent unexpected breakages from OS or Safari updates.

## Ci Setup Summary

The setup requires a macOS-based CI runner, such as GitHub Actions' `macos-15` image. Since `safaridriver` and Safari are pre-installed on these runners, there are no large browser downloads. The primary setup steps involve ensuring Safari's 'Allow Remote Automation' setting is enabled (which is often pre-configured on hosted runners) and running `sudo safaridriver --enable` to authorize the WebDriver server. Tests are then configured to point the Selenium RemoteWebDriver to the `safaridriver` instance. The WebdriverIO `@wdio/safaridriver-service` is noted as archived and deprecated.


# Open Source Reference Implementations

## Repository Name

Microsoft Playwright

## Repository Url

https://github.com/microsoft/playwright

## Ci Platform

GitHub Actions

## Key Practices Observed

The project provides a ready-made GitHub Action workflow (`playwright.yml`) that executes tests for Chromium, Firefox, and WebKit on a macOS runner. Key practices include pinning the runner image (e.g., `macos-15`) to ensure a consistent environment, including steps to enable 'Allow Remote Automation' for Safari, and ensuring a GUI session is active. The Playwright test runner has built-in capabilities to automatically capture screenshots, videos, and execution traces on failure, and it can emit test results in JUnit XML format for CI integration. It also features a built-in test retry configuration (`test.retry`) to handle flakiness.

## Stability Analysis

The GitHub Action workflows for Playwright demonstrate a high degree of stability, with a success rate greater than 95% over a 30-day period, as indicated by 'build: passing' badges. The integrated features for retries and detailed tracing are noted to dramatically reduce the impact of flaky failures and aid in debugging.

## Repository Name

WebKit (WebKit/WebKit)

## Repository Url

https://github.com/WebKit/WebKit

## Ci Platform

GitHub Actions

## Key Practices Observed

The official WebKit repository contains CI configurations for testing the engine itself on macOS. It utilizes scripts like `run-safari` to launch Safari Technology Preview and set necessary environment variables. The CI setup relies on self-hosted macOS runners using the default macOS image. This provides a reference for testing against the very latest browser engine changes.

## Stability Analysis

The CI runs for the WebKit project are more variable in their success rate. This is primarily because they are testing against the latest, often experimental, builds of the Safari Technology Preview. Failures are frequently logged in the CI history and are often attributed to upstream engine changes rather than CI configuration issues.

## Repository Name

SeleniumHQ/selenium

## Repository Url

https://github.com/SeleniumHQ/selenium

## Ci Platform

GitHub Actions / CircleCI / Buildkite

## Key Practices Observed

The Selenium project demonstrates how to run Safari WebDriver tests across multiple CI platforms. The documentation and example configurations emphasize the prerequisite of enabling 'Allow Remote Automation' and running `safaridriver --enable`. Example CI files within the repository and community forks show macOS runner usage and the archiving of artifacts, particularly JUnit XML reports. For handling flakiness, the common practice is to wrap test execution in a script that re-runs failed tests, such as using `pytest-rerunfailures`.

## Stability Analysis

Tests using Selenium with Safari are noted to be potentially flaky, especially on the first run. This is often due to the requirement for a logged-in user session. A common technique to improve stability is to introduce a short `sleep` delay after enabling Remote Automation to ensure the setting is applied before tests begin.

## Repository Name

lxman/safari-mcp-server

## Repository Url

https://github.com/lxman/safari-mcp-server

## Ci Platform

GitHub Actions

## Key Practices Observed

This repository provides a lightweight helper utility that is not a test suite itself but serves as a valuable reference. It demonstrates the exact macOS prerequisites for Safari automation, such as enabling the Developer menu and Remote Automation. It also includes crucial troubleshooting steps, like the `sudo safaridriver --enable` command. It is frequently referenced for creating custom CI scripts that require explicit permission handling for Safari.

## Stability Analysis

As a helper repository, it does not have its own CI badge or build history to analyze. However, its value and reliability are indicated by its consistent referencing in other projects and community discussions, showing it is a trusted source for understanding Safari's automation setup.


# Headless Safari Analysis

## Native Safari Support

False

## Native Safari Details

Apple's `safaridriver` does not provide a true, supported headless mode. It is designed to automate the user-facing Safari application, which fundamentally requires an active macOS GUI session (a running WindowServer) to render content and process interactions. Attempts to run it in a non-GUI environment will fail. This limitation means that any CI job using `safaridriver` must run on a full macOS virtual machine with a logged-in user session.

## Webkit Engine Support

True

## Webkit Engine Details

The WebKit engine, as bundled and automated by frameworks like Playwright, fully supports a robust headless mode. Playwright achieves this by launching and controlling its own build of the WebKit engine directly, rather than the installed Safari application. This approach bypasses the need for the Safari app's UI, a GUI session, and macOS-specific UI automation permissions (like 'Allow Remote Automation'). This makes it significantly faster, more stable, and better suited for isolated, parallel execution within CI environments.

## Recommendation

For any headless testing needs, the recommended approach is to use Playwright with its WebKit browser. This provides the speed, reliability, and isolation required for efficient CI pipelines. Native Safari with `safaridriver` should only be used for high-fidelity, headed tests where validating against the actual branded Safari browser is a strict requirement. A hybrid strategy is often effective: run the majority of tests headlessly against WebKit for speed, and a smaller, critical set of tests against headed Safari for final validation.


# Parallel Execution Strategies

## Safaridriver Limitations

The `safaridriver` has a fundamental architectural limitation: it only permits one active automation session per macOS user at a time. It controls the actual Safari browser, which is a single, user-facing application. This makes it impossible to run multiple independent `safaridriver` tests in parallel on a single CI runner or within a single user session, as they would conflict for control of the browser.

## Safaridriver Scaling Strategy

To achieve parallelism with `safaridriver`, tests must be scaled horizontally across multiple, completely isolated environments. The most common and reliable strategy is to use multiple CI runners (e.g., a matrix of `macos-15` jobs in GitHub Actions). Each runner acts as a separate machine with its own user session, allowing one Safari test to run per runner. While effective, this strategy significantly increases CI costs and execution time compared to in-machine parallelism.

## Playwright Webkit Strategy

Playwright's WebKit offers a superior parallelism model. It has built-in support for test sharding and running tests across multiple worker processes on a single machine. Each worker runs in an isolated context, effectively launching its own independent, headless WebKit instance. This allows for true, concurrent test execution on one CI runner, making it far more resource-efficient and faster than the `safaridriver` approach.

## Resource Contention Risks

Running multiple UI automation tests concurrently on macOS, especially headed tests, introduces a high risk of resource contention. This includes conflicts over TCC (Transparency, Consent, and Control) permissions for Accessibility and AppleEvents, as the system may prompt for permissions and only one prompt can be active. There is also contention for window focus and control of the system-wide UI, which can cause tests to fail unpredictably if they are not in the foreground. These issues are a primary source of flakiness in parallel macOS UI testing.

## Mitigation For Contention

For self-hosted runners, contention can be mitigated by creating a pre-configured machine image with a configuration profile (`.mobileconfig`) that pre-grants TCC permissions for Accessibility and AppleEvents, bypassing runtime prompts. For hosted runners where this is not possible, the best strategy is to isolate tests by running only one UI test per machine (the `safaridriver` model). The most effective mitigation, however, is to avoid the problem entirely by using Playwright's headless WebKit, which does not rely on these contentious UI-level system resources.


# Test Runner Architecture Design

## Configuration Loading

A robust pattern involves loading test runner configuration from a dedicated file, such as a YAML or JSON file (e.g., `config.yaml`). This file should define all critical parameters for the test run, including the target browser (e.g., Safari on `macos-latest`), worker count for parallelism, retry policies (e.g., max retries, backoff strategy), test sharding strategies, and global timeout values. This approach externalizes configuration from the test code, making it easier to manage different environments (local vs. CI) and to adjust settings without modifying the runner's source code.

## Worker Pool Management

The design should utilize a worker pool to execute tests in parallel. The main process spawns a configurable number of worker processes (N). These workers pull test cases or test files from a shared queue. Each worker is responsible for managing its own browser session, for instance, by launching an independent Safari WebDriver session. This model ensures that tests are executed concurrently up to the specified level of parallelism, maximizing the use of available machine resources and reducing overall test execution time. The main process coordinates the distribution of work and the collection of results from the workers.

## Sharding And Retry Logic

To efficiently distribute the test suite, sharding strategies should be implemented. Tests can be divided (sharded) by file, by class, or by estimated duration based on historical data to ensure balanced workloads across workers. A manifest file can be used to store the shard metadata that workers reference. For flakiness mitigation, a sophisticated retry logic is essential. When a test fails, it should be re-queued for execution up to a configured maximum number of retries (`maxRetries`). Implementing an exponential backoff strategy (e.g., delaying retries by 2^attempt seconds) can help overcome transient issues. A 'flaky-test quarantine' mechanism can be added to move tests that fail repeatedly to a separate list for an isolated re-run at the end, preventing them from blocking the main test run.

## Graceful Shutdown Handling

The test runner must handle system signals like SIGINT (Ctrl+C) and SIGTERM to ensure a clean and orderly shutdown, which is critical in CI environments to prevent orphaned processes and resource leaks. The runner should register a signal handler that, upon receiving a shutdown signal, initiates a graceful teardown sequence. This involves stopping the distribution of new tasks to workers, allowing in-flight tests to complete (or aborting them after a timeout), cleanly terminating all browser and driver sessions (e.g., killing Safari driver processes), and flushing any pending test reports to disk before exiting.

## Ci Integration Features

For seamless CI integration, the runner should adhere to standard conventions. It must use specific exit codes to communicate the result of the test run: `0` for success (all tests passed), `1` for test failures, and other non-zero codes (e.g., `2`) for infrastructure or setup errors. The runner should generate reports in a standard format like JUnit XML or the Test Anything Protocol (TAP), which are widely supported by CI platforms like GitHub Actions, GitLab, and Jenkins. To enhance visibility, the runner can emit CI-native annotations directly to the build log for each failed test, such as `::error` annotations in GitHub Actions, which pinpoints failures directly in the code and logs.


# Reporting And Artifact Integration

## Junit Xml Format Details

The JUnit XML format is the de-facto standard for test reporting on CI platforms like GitHub Actions, GitLab, and Jenkins. Its core schema elements include `<testsuite>` to group tests, `<testcase>` for individual tests, and child elements like `<failure>`, `<error>`, or `<skipped>` to denote the outcome. The `<system-out>` and `<system-err>` tags are commonly used to capture log output and can be repurposed to include links to artifacts like screenshots. CI compatibility has some quirks; for instance, GitLab CI may require a non-zero exit code from the job script in addition to the JUnit report to mark the job as failed, while the Jenkins JUnit plugin might ignore custom attributes without a specific plugin to process them.

## Tap Protocol Details

The Test Anything Protocol (TAP), specifically version TAP13, is a lightweight, streaming-friendly alternative to JUnit XML. It uses a simple plain-text, line-oriented format with directives like `ok` and `not ok`. A key feature of TAP13 is the use of optional YAML blocks for diagnostics, which provides a structured way to include detailed failure information, such as stack traces or attachment paths, improving machine readability. TAP is preferred when the test runner already produces line-oriented output (e.g., Node-tap) or when the CI platform has native TAP ingestion capabilities, as it can be simpler to generate and parse in streaming contexts.

## Screenshot Attachment Method

Screenshots from failed tests are typically attached or referenced within test reports for easy access from the CI dashboard. A common method is to upload the screenshot files as CI job artifacts (e.g., using `actions/upload-artifact` in GitHub Actions). Then, a reference to the artifact is embedded within the JUnit XML report. This can be done by placing a relative path or a full URL to the screenshot inside a `<system-out>` tag. Some CI systems can parse these paths and create direct links. For example, an HTML `<img>` tag pointing to the artifact URL can be included in the system output for rich rendering in some report viewers.

## Log Attachment Method

Similar to screenshots, diagnostic files like logs or execution traces (e.g., Playwright's `trace.zip`) are attached to test reports by first uploading them as CI job artifacts. The path or URL to the uploaded artifact is then included in the test report. In JUnit XML, this is typically done within the `<system-out>` or `<system-err>` tags associated with the failed test case. In TAP, the file path can be included in the YAML diagnostic block under a key like `attachments`. This ensures that all relevant diagnostic information is linked directly to the test that produced it, streamlining the debugging process.


# Failure Screenshot Best Practices

## Naming Convention

To ensure uniqueness and traceability, a deterministic naming convention for screenshot files is recommended. A robust pattern includes the test suite name, the specific test case name, a timestamp, and a worker ID if tests are run in parallel. An example would be `<suite>--<test-case>--<timestamp>--<worker-id>.png`. This convention prevents file collisions and makes it easy to associate a screenshot with the exact test run and execution context that produced it.

## Storage Pattern

The best practice for storing screenshots in a CI environment is to upload them as job artifacts. For example, in GitHub Actions, the `actions/upload-artifact` action can be used. Screenshots should be organized into a structured directory within the artifacts, such as `artifacts/screenshots/<job-id>/<suite-name>/`. This keeps them organized and accessible after the CI job has completed. For long-term storage or sharing, they can also be uploaded to an external object store like Amazon S3.

## Report Integration Method

To link screenshots directly to the test results in the CI dashboard, their paths or URLs should be embedded in the final test report. For JUnit XML reports, this is commonly achieved by inserting the relative path or full URL to the uploaded artifact within the `<system-out>` tag of the corresponding `<testcase>`. Some CI systems can parse these links and display them directly in the UI. An alternative is to add a custom `<property>` tag with the artifact URL.

## Capture Type

To maximize diagnostic value, it is recommended to capture both a full-page screenshot and a viewport-only screenshot upon test failure. The viewport screenshot shows what was visible to the user at the moment of failure, while the full-page screenshot provides context of the entire page layout. Additionally, capturing interim screenshots at key steps of a test can help create a visual timeline of the test execution, making it easier to pinpoint where the test deviated from the expected behavior.


# Fixture Serving Techniques

## Technique

A hybrid approach is recommended, utilizing either Playwright's built-in `webServer` configuration or a custom lightweight Node.js HTTP/HTTPS server. Playwright's `webServer` option is a convenient launcher that can start a specified command (like an `npm` script) before tests, wait for it to be ready, and tear it down afterward. For more complex needs, a custom server built with Node.js using libraries like `express` with `serve-static` for static assets, or the native `http` and `http2` modules, offers greater flexibility for handling dynamic routes, HTTPS/HTTP2, and specific caching headers.

## Isolation Method

To ensure complete isolation between parallel tests, the best practice is to run one server instance per worker. Each worker process starts its own fixture server on a unique, dynamically allocated port. This prevents any state leakage or resource interference between concurrent tests. An alternative, though less robust, method is using a single shared server with namespacing, where each test uses a unique URL path prefix (e.g., `/tenant-id-123/fixture.html`) to isolate its assets. However, the one-server-per-worker model provides the strongest guarantee of isolation.

## Port Allocation Strategy

To avoid port conflicts during parallel execution, the recommended strategy is to use ephemeral ports. This is achieved by instructing the server to listen on port `0`. The operating system will automatically assign a free, unused port from the ephemeral range. The test runner or worker process must then read the dynamically assigned port number from the server instance (e.g., via `server.address().port` in Node.js) and communicate it to the browser test, either through an environment variable, a temporary file, or inter-process communication (IPC).

## Https Tls Handling

Testing over HTTPS on macOS with Safari requires special handling because Safari strictly enforces that TLS certificates must be trusted by the macOS system keychain. The process involves generating a self-signed root Certificate Authority (CA) and using it to sign a leaf certificate for the test server (e.g., for `localhost` and `127.0.0.1` via SANs). In the CI environment, this root CA certificate must be added to either the System or login keychain and explicitly marked as trusted using the `security add-trusted-cert` command-line tool. This step often requires `sudo` privileges if modifying the System keychain.

## Lifecycle Management

The server lifecycle must be tightly managed within the CI job. This includes a startup phase with readiness probes, an operational phase, and a graceful shutdown. The test runner should wait for the server to be ready by polling a health check endpoint (e.g., `/__health`) or waiting for the TCP port to become available, with a configurable timeout. For shutdown, the runner must send a SIGINT or SIGTERM signal to the server process, which should have a handler to close connections and clean up resources before exiting. This prevents orphaned server processes from lingering after the test run completes.


# Stability And Flakiness Mitigation

## Technique

Test Retries with Backoff

## Description

This technique automatically re-runs a failed test a configured number of times. It is highly effective at mitigating transient, non-deterministic issues such as network glitches, temporary resource unavailability, or race conditions in the application under test. Adding an exponential backoff delay between retries gives the system time to recover from temporary faults, increasing the chance of a successful subsequent attempt.

## Implementation Example

In Playwright, configure retries in `playwright.config.js`: `retries: 2`. For Selenium-based frameworks, use a runner-level plugin like `pytest-rerunfailures` for Python or wrap the execution in a script that re-invokes the test on a non-zero exit code.

## Impact Level

High


# Cost And Performance Tradeoffs

## Testing Strategy

Full Fidelity Testing with `safaridriver` on macOS

## Runner Environment

macOS Runners (e.g., GitHub Actions `macos-15`, CircleCI macOS, or self-hosted macOS agents).

## Relative Cost

High. macOS runners are significantly more expensive per minute than Linux runners. Scaling tests by provisioning multiple parallel runners directly and linearly increases CI costs.

## Performance Characteristics

Slower execution with limited parallelism. `safaridriver` is restricted to a single UI-driven browser session per macOS user, preventing parallel test execution on a single machine. The primary strategy for parallelism is to shard the test suite across multiple, independent macOS CI jobs, which adds to overall execution time and cost.

## Fidelity Tradeoff

Highest fidelity. This strategy tests the actual, branded Safari browser, ensuring 100% accuracy for Safari-specific rendering, JavaScript behavior, security policies like Intelligent Tracking Prevention (ITP), and Apple-specific integrations. This is in contrast to lower-fidelity but faster alternatives like testing Playwright's WebKit engine, which may not exhibit identical behavior.


# Recommended Ci Workflow Checklist

## Step Order

1.0

## Action Item

Establish a complete and reliable Safari CI workflow: Pin the runner, enable WebDriver, configure parallelism, implement retries, and capture artifacts.

## Rationale

A comprehensive, multi-step workflow is essential to overcome the unique challenges of Safari automation. This approach addresses the key failure points: environment instability (by pinning the runner), restrictive permissions (by enabling `safaridriver`), poor performance (by defining a parallelism strategy), inherent flakiness (with retries), and difficult debugging (with rich artifacts).

## Implementation Notes

1. **Pin Runner:** Use `runs-on: macos-15` in the CI job. 2. **Enable WebDriver:** Execute `sudo safaridriver --enable` in a setup step. 3. **Parallelize:** Use a CI matrix to run test shards across multiple macOS jobs. 4. **Add Retries:** Configure your test framework for retries (e.g., Playwright's `retries: 2`). 5. **Capture Artifacts:** On failure, save screenshots, videos, and traces, then upload them using a CI command like `actions/upload-artifact`. 6. **Report Results:** Generate a JUnit XML report for CI platform integration.

