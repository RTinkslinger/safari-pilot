# P2: CI Browser Testing -- Research Report

**Date:** 2026-04-12
**Scope:** Test runner CLI, JUnit/TAP output, fixture serving, screenshot-on-failure, parallel execution for Safari on macOS CI
**Context:** Safari Pilot v0.1.0 shipped with 74 MCP tools across 3 engine tiers (AppleScript, Swift Daemon, Safari Web Extension). This research informs the P2 roadmap item for CI browser testing infrastructure.

---

## Table of Contents

1. [Safari on CI Infrastructure](#1-safari-on-ci-infrastructure)
2. [Existing Safari CI Testing Approaches](#2-existing-safari-ci-testing-approaches)
3. [Test Runner Architecture](#3-test-runner-architecture)
4. [Fixture Serving](#4-fixture-serving)
5. [Screenshot on Failure](#5-screenshot-on-failure)
6. [Parallel Execution](#6-parallel-execution)
7. [Headless Safari](#7-headless-safari)
8. [Architecture Recommendations for Safari Pilot](#8-architecture-recommendations-for-safari-pilot)

---

## 1. Safari on CI Infrastructure

### 1.1 GitHub Actions macOS Runners

GitHub Actions provides three macOS runner labels. Safari and `safaridriver` are **pre-installed** on all of them.

| Runner Label | macOS Version | Safari Version | safaridriver | Notes |
|---|---|---|---|---|
| `macos-15` | macOS 15.7.5 (24G617) | Safari 26.4 (20624.1.16.18.2) | 26.4 | Current latest. Includes logged-in GUI session. |
| `macos-14` | macOS 14.8.5 (23J423) | Safari 26.4 (19624.1.16.18.2) | 26.4 | Previous version. Same Safari version via updates. |
| `macos-latest` | Alias for `macos-15` | Same as macos-15 | Same | **Pin to specific version** for stability. |

**Source:** [actions/runner-images macos-15-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md), [macos-14-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-14-Readme.md)

Additional pre-installed testing infrastructure on these runners:
- Selenium Server 4.41.0
- Chrome + ChromeDriver, Edge + EdgeDriver, Firefox + geckodriver
- Node.js, Python, Ruby, Java runtimes

**Critical:** Always pin to a specific version (e.g., `runs-on: macos-15`) rather than `macos-latest`. The alias changes without notice and can break workflows when Safari or macOS versions shift.

### 1.2 Permissions on CI

Safari automation requires two categories of permissions:

#### A. "Allow Remote Automation" (Developer Menu)

This is the primary gate. Without it, `safaridriver` refuses to create sessions with:
```
SessionNotCreatedError: You must enable the 'Allow Remote Automation' option
in Safari's Develop menu to control Safari via WebDriver.
```

**How to enable non-interactively:**

```bash
# The primary CI command -- run once in setup step
sudo /usr/bin/safaridriver --enable
```

This command does two things:
1. Enables the Develop menu in Safari
2. Authorizes `safaridriver` to launch the `webdriverd` service

On GitHub Actions hosted runners, this is typically sufficient because the runner images come with a logged-in GUI session and pre-configured base settings. On some runners, a short delay after enabling may be needed for the setting to propagate:

```bash
sudo safaridriver --enable
sleep 2  # Allow setting to propagate
```

**The old `defaults write` approach no longer works reliably on modern macOS:**

```bash
# These commands are UNRELIABLE on macOS 13+ / CI environments:
defaults write com.apple.Safari IncludeDevelopMenu -bool true
defaults write com.apple.Safari AllowRemoteAutomation -bool true
defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool true
```

On modern macOS (13+), the TCC (Transparency, Consent, and Control) framework and SIP (System Integrity Protection) restrict `defaults write` from fully controlling Safari's security settings. The `sudo safaridriver --enable` command is the Apple-supported path.

**Source:** [WebKit Blog: WebDriver Support in Safari 10](https://webkit.org/blog/6900/webdriver-support-in-safari-10/), [CircleCI: Enabling safaridriver support on macOS](https://support.circleci.com/hc/en-us/articles/360056461992-Enabling-safaridriver-support-on-macOS)

#### B. TCC Permissions (Accessibility & Apple Events)

For Safari Pilot specifically (which uses AppleScript and Accessibility APIs beyond just WebDriver), two additional TCC permissions are relevant:

| Permission | What Needs It | How to Grant on CI |
|---|---|---|
| Accessibility (`kTCCServiceAccessibility`) | AppleScript GUI scripting, `osascript` controlling Safari | Configuration Profile (MDM) on self-hosted; unreliable on hosted |
| Apple Events (`kTCCServiceAppleEvents`) | `osascript` sending Apple Events to Safari | Configuration Profile (MDM) on self-hosted; unreliable on hosted |

**Methods to grant TCC permissions (ranked by reliability):**

1. **Configuration Profiles (MDM)** -- Most reliable. Create a `.mobileconfig` file specifying bundle IDs to grant permissions. Install with `profiles` CLI. Only works on self-hosted runners where you have admin control.

2. **`sudo safaridriver --enable`** -- Handles WebDriver permissions but NOT general AppleScript/Accessibility permissions.

3. **Direct TCC.db edits** -- **Blocked by SIP on modern macOS.** Not viable.

4. **`tccutil`** -- Can only RESET permissions, not grant them. Not useful.

**Implication for Safari Pilot on hosted CI:** The AppleScript engine and certain features requiring Accessibility permissions may not work on GitHub Actions hosted runners. The test runner should detect this and fall back gracefully -- either using only the subset of tools that work via `safaridriver`/WebDriver, or documenting that full Safari Pilot CI testing requires self-hosted runners.

### 1.3 CircleCI and Buildkite

| Platform | macOS Availability | Safari Access | Notes |
|---|---|---|---|
| CircleCI | macOS images tied to Xcode versions | `safaridriver` available; same TCC restrictions as GH Actions | Self-hosted executors recommended for full control |
| Buildkite | Self-hosted agents only (on user's Mac hardware) | Full control -- best option for Safari testing | Create a "golden image" with all permissions pre-configured |

**CircleCI setup:**
```yaml
# .circleci/config.yml
jobs:
  safari-tests:
    macos:
      xcode: "15.4"  # Determines macOS version
    steps:
      - run: sudo safaridriver --enable
      - run: npm test
```

**Source:** [CircleCI: Enabling safaridriver support](https://support.circleci.com/hc/en-us/articles/360056461992-Enabling-safaridriver-support-on-macOS)

### 1.4 Self-Hosted Runner Golden Image

For maximum reliability, create a pre-configured macOS image:

1. Enable auto-login (user logs in automatically on boot -- ensures GUI session)
2. Install a `.mobileconfig` profile granting Accessibility + Apple Events to `safaridriver`, `osascript`, Terminal, and the test runner process
3. Run `sudo safaridriver --enable`
4. Enable "Allow JavaScript from Apple Events" in Safari (Develop menu)
5. Snapshot/clone this image for all CI agents

---

## 2. Existing Safari CI Testing Approaches

### 2.1 Apple's `safaridriver`

`safaridriver` is Apple's built-in WebDriver implementation, located at `/usr/bin/safaridriver`. It implements the W3C WebDriver protocol.

**Architecture:**
- `safaridriver` starts a local REST API server
- Client libraries (Selenium, WebdriverIO) send HTTP requests to this server
- `safaridriver` forwards commands through WebKit's UIProcess and WebProcess layers via `WebAutomationSession`
- Commands execute synchronously

**Key characteristics:**
- **Single session only:** "Only one Safari browser instance can be running at any given time, and only one WebDriver session can be attached to the browser instance." This is a hard architectural constraint, not a configuration option.
- **Automation windows:** Tests run in isolated windows with distinctive orange address bars. These windows "start with a clean slate and cannot access Safari's normal browsing history, AutoFill data, or other sensitive information."
- **Glass pane:** During automation, a glass pane blocks user interaction. Users can click through to interrupt, which permanently severs the WebDriver connection.
- **Built-in capabilities:** `automaticInspection` (preloads Web Inspector), `automaticProfiling` (starts timeline recording)

**Source:** [WebKit Blog: WebDriver Support in Safari 10](https://webkit.org/blog/6900/webdriver-support-in-safari-10/)

### 2.2 How Safari Pilot Differs from safaridriver

Safari Pilot's architecture is fundamentally different from `safaridriver`:

| Aspect | safaridriver | Safari Pilot |
|---|---|---|
| Protocol | W3C WebDriver (HTTP REST) | MCP (Model Context Protocol) |
| Control mechanism | WebAutomationSession (internal WebKit API) | AppleScript + Swift Daemon + Safari Web Extension |
| Session model | Isolated automation windows, clean slate | Real authenticated sessions, persistent state |
| Concurrency | Single session per machine | Potentially multiple (via tabs/windows with AppleScript) |
| Browser state | Ephemeral (no cookies, history, AutoFill) | Persistent (accesses real user sessions) |

**Critical implication for CI:** Safari Pilot's test runner does NOT need `safaridriver` at all. It controls Safari through its own engines. This means:
- No "Allow Remote Automation" requirement (for AppleScript/Extension engines)
- But Apple Events/Accessibility permissions ARE needed (for AppleScript engine)
- The Swift Daemon engine communicates via stdin/stdout, avoiding system permission issues
- The Extension engine uses native messaging, also avoiding TCC

### 2.3 Selenium with Safari

Standard Selenium + safaridriver approach for CI:

```javascript
const { Builder } = require('selenium-webdriver');
const safari = require('selenium-webdriver/safari');

const driver = await new Builder()
  .forBrowser('safari')
  .setSafariOptions(new safari.Options())
  .build();
```

GitHub Actions workflow:
```yaml
jobs:
  test:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - run: sudo safaridriver --enable
      - run: npm test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: test-results
          path: test-results/
```

**Source:** [SeleniumHQ/selenium](https://github.com/SeleniumHQ/selenium), [Selenium Safari documentation](https://www.selenium.dev/documentation/webdriver/browsers/safari/)

### 2.4 WebdriverIO with Safari

The `@wdio/safaridriver-service` is **archived and deprecated**. Current approach is to use safaridriver directly:

```javascript
// wdio.conf.js
exports.config = {
  runner: 'local',
  capabilities: [{
    browserName: 'safari',
    'safari:automaticInspection': true
  }],
  services: [],  // No special service needed
  path: '/',
  port: 4444
};
```

### 2.5 Open-Source Projects Running Safari Tests in CI

| Project | CI Platform | Approach | Stability |
|---|---|---|---|
| [Microsoft Playwright](https://github.com/microsoft/playwright) | GitHub Actions | WebKit engine (not real Safari), pinned macOS runners, built-in retries/tracing | >95% success rate |
| [WebKit/WebKit](https://github.com/WebKit/WebKit) | GitHub Actions | Self-hosted macOS runners, Safari Technology Preview, custom `run-safari` scripts | Variable (testing bleeding-edge engine) |
| [SeleniumHQ/selenium](https://github.com/SeleniumHQ/selenium) | GH Actions + CircleCI + Buildkite | `safaridriver --enable`, JUnit XML reports, `pytest-rerunfailures` | Known flaky on first run |
| [lxman/safari-mcp-server](https://github.com/lxman/safari-mcp-server) | GitHub Actions | Documents exact macOS prerequisites, `sudo safaridriver --enable` troubleshooting | Reference implementation, not test suite |

---

## 3. Test Runner Architecture

### 3.1 Design Goals for Safari Pilot's Test Runner

The test runner should be a **standalone CLI** (not a Vitest plugin). Reasons:
- Safari Pilot users may not use Vitest
- The runner needs to manage Safari lifecycle (launch, control, teardown)
- Fixture serving is tightly coupled to test execution
- Screenshot capture requires integration with Safari Pilot's own screenshotting tools
- JUnit/TAP output is a first-class feature, not an afterthought

### 3.2 CLI Interface Design

```bash
# Run all tests
safari-pilot-test

# Run specific test files
safari-pilot-test tests/login.test.js tests/checkout.test.js

# Configuration
safari-pilot-test --config safari-test.config.js

# Output formats
safari-pilot-test --reporter junit --output results.xml
safari-pilot-test --reporter tap

# Parallel execution
safari-pilot-test --workers 4

# Retry flaky tests
safari-pilot-test --retries 2

# Serve fixtures
safari-pilot-test --fixtures ./test/fixtures --port 0

# Screenshot on failure
safari-pilot-test --screenshot-on-failure --screenshot-dir ./screenshots
```

### 3.3 JUnit XML Format

There is no official JUnit XML specification. The format originated from Apache Ant and has been adopted (with variations) across the ecosystem. The following documents the common subset supported by GitHub Actions, GitLab CI, Jenkins, and CircleCI.

**Reference:** [testmoapp/junitxml](https://github.com/testmoapp/junitxml) -- the most comprehensive community documentation of the format.

#### Schema Structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  <testsuites> - Root element (optional; some tools use <testsuite> as root)
  Attributes: name, tests, failures, errors, skipped, time, timestamp
-->
<testsuites name="Safari Pilot Tests" tests="8" failures="1" errors="0"
    skipped="1" time="16.08" timestamp="2026-04-12T15:48:23">

  <!--
    <testsuite> - Groups test cases (like a test file or describe block)
    Attributes: name (required), tests, failures, errors, skipped,
                time, timestamp, hostname, id, package, file
  -->
  <testsuite name="Login Tests" tests="3" failures="1" errors="0"
      time="6.6" file="tests/login.test.js">

    <!-- Optional properties for the suite -->
    <properties>
      <property name="browser" value="Safari 26.4"/>
      <property name="os" value="macOS 15"/>
    </properties>

    <!-- Passing test: no child elements -->
    <testcase name="should display login form"
        classname="Login Tests" time="2.1"
        file="tests/login.test.js" line="12"/>

    <!-- Failing test: <failure> child -->
    <testcase name="should reject invalid password"
        classname="Login Tests" time="1.3"
        file="tests/login.test.js" line="28">
      <failure message="Expected 'error' class on input" type="AssertionError">
Error: Expected element to have class 'error'
  at login.test.js:35:5
  at Context.test (runner.js:142:8)
      </failure>
      <!-- Screenshot attachment via system-out -->
      <system-out>
[[ATTACHMENT|screenshots/login-tests--should-reject-invalid-password--1712934503.png]]
      </system-out>
    </testcase>

    <!-- Skipped test -->
    <testcase name="should handle 2FA" classname="Login Tests" time="0">
      <skipped message="2FA not implemented yet"/>
    </testcase>

    <!-- Suite-level output -->
    <system-out>Suite setup completed in 0.5s</system-out>
    <system-err/>
  </testsuite>
</testsuites>
```

#### Key Attributes Reference

| Element | Required Attributes | Optional Attributes |
|---|---|---|
| `<testsuites>` | (none) | `name`, `tests`, `failures`, `errors`, `skipped`, `time`, `timestamp` |
| `<testsuite>` | `name` | `tests`, `failures`, `errors`, `skipped`, `time`, `timestamp`, `hostname`, `id`, `package`, `file` |
| `<testcase>` | `name` | `classname`, `time`, `assertions`, `status`, `file`, `line` |
| `<failure>` | (none) | `message`, `type` (text content = stack trace) |
| `<error>` | (none) | `message`, `type` (text content = stack trace) |
| `<skipped>` | (none) | `message` |

#### Screenshot Attachments in JUnit XML

Two conventions exist:

1. **`[[ATTACHMENT|path]]` in `<system-out>`** -- Jenkins JUnit Attachments plugin convention. Widely supported.
   ```xml
   <system-out>[[ATTACHMENT|screenshots/failure.png]]</system-out>
   ```

2. **`<property>` with file path or data URI** -- testmoapp convention.
   ```xml
   <properties>
     <property name="attachment" value="screenshots/failure.png"/>
   </properties>
   ```

**Recommendation:** Use the `[[ATTACHMENT|path]]` convention in `<system-out>` for broadest CI compatibility. GitHub Actions can then upload the referenced directory as an artifact.

**Source:** [testmoapp/junitxml](https://github.com/testmoapp/junitxml), [StackOverflow: JUnit XML format specification](https://stackoverflow.com/questions/4922867/what-is-the-junit-xml-format-specification-that-hudson-supports)

### 3.4 TAP (Test Anything Protocol) v13

TAP is a line-oriented text protocol. TAP13 adds YAML diagnostic blocks for structured failure data.

**Source:** [TAP v13 Specification](https://testanything.org/tap-version-13-specification.html)

#### Format Structure

```
TAP version 13
1..N
```

- **Version line:** Must be first line: `TAP version 13`
- **Plan line:** `1..N` where N is total test count. Can appear first or last.
- **Test lines:** `ok` or `not ok`, optional number, optional description, optional directive

#### Complete Example

```
TAP version 13
1..4
ok 1 - Login form renders correctly
not ok 2 - Rejects invalid credentials
  ---
  message: "Expected 'error' class on input element"
  severity: fail
  screenshot: screenshots/test-2-failure.png
  data:
    selector: "#password-input"
    expected_class: "error"
    actual_classes: "form-input"
  duration_ms: 1342
  ...
ok 3 - Accepts valid credentials # 1205ms
not ok 4 - Handles 2FA prompt # TODO Not implemented yet
  ---
  message: "2FA feature not yet built"
  severity: todo
  ...
```

#### TAP Elements

| Element | Syntax | Example |
|---|---|---|
| Pass | `ok [N] [- description]` | `ok 1 - Page loads` |
| Fail | `not ok [N] [- description]` | `not ok 2 - Button click` |
| Skip | `ok N description # SKIP reason` | `ok 3 - IE test # SKIP Safari only` |
| Todo | `not ok N description # TODO reason` | `not ok 4 - Feature # TODO WIP` |
| Diagnostic | `# comment text` | `# Running login suite` |
| YAML block | Indented `---` ... `...` | See example above |
| Bail out | `Bail out! reason` | `Bail out! Safari crashed` |

#### TAP vs JUnit XML Tradeoffs

| Aspect | JUnit XML | TAP13 |
|---|---|---|
| CI platform support | Universal (GitHub Actions, GitLab, Jenkins, CircleCI all parse it natively) | Limited native support; needs conversion for most CI dashboards |
| Streaming | Not streamable (XML must be complete) | Fully streamable (line-by-line) |
| Attachments | `<system-out>` with `[[ATTACHMENT|...]]` or `<property>` | YAML diagnostic block with custom keys |
| Complexity | Moderate (XML generation) | Simple (string concatenation) |
| Human readability | Low (XML) | High (plain text) |

**Recommendation:** Support both. Default to JUnit XML for CI integration. Offer TAP for terminal output and piping. Implement a reporter interface so both (and custom reporters) are pluggable.

### 3.5 Test Execution Architecture

```
                    +-----------------+
                    |   CLI Entry     |
                    |  (bin/sp-test)  |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Config Loader  |  <-- safari-test.config.js
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Test Discovery |  <-- glob patterns, file args
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Test Scheduler |  <-- sharding, ordering
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
        +-----v-----+  +----v----+  +------v------+
        |  Worker 1  |  | Worker 2|  |  Worker N   |
        |            |  |         |  |             |
        | - Fixture  |  |  ...    |  |  ...        |
        |   Server   |  |         |  |             |
        | - Safari   |  |         |  |             |
        |   Pilot    |  |         |  |             |
        |   instance |  |         |  |             |
        +-----+------+  +----+----+  +------+------+
              |              |              |
              +--------------+--------------+
                             |
                    +--------v--------+
                    |  Result Merger  |
                    +--------+--------+
                             |
                    +--------v--------+
                    |   Reporters     |
                    |  JUnit / TAP /  |
                    |  Console        |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Exit Code      |
                    |  0=pass 1=fail  |
                    |  2=infra error  |
                    +-----------------+
```

### 3.6 Setup/Teardown, Retry, and Lifecycle

**Test lifecycle hooks:**

```javascript
// safari-test.config.js
export default {
  // Global setup: runs once before all tests
  globalSetup: async (pilot) => {
    // Start fixture server, verify Safari is available, etc.
  },

  // Global teardown: runs once after all tests
  globalTeardown: async (pilot) => {
    // Stop fixture server, close Safari windows, etc.
  },

  // Per-test hooks
  beforeEach: async (test, pilot) => {
    // Navigate to base URL, clear state, etc.
  },

  afterEach: async (test, pilot, result) => {
    // Screenshot on failure, collect logs, etc.
    if (result.status === 'failed') {
      await pilot.screenshot({ path: `screenshots/${test.name}.png` });
    }
  },

  // Retry configuration
  retries: 2,             // Retry failed tests up to 2 times
  retryDelay: 1000,       // 1s delay between retries
  retryBackoff: 'exponential',  // 1s, 2s, 4s

  // Timeouts
  testTimeout: 30000,     // Per-test timeout
  globalTimeout: 300000,  // Entire suite timeout
};
```

**Retry with exponential backoff:**
- Attempt 1: immediate
- Attempt 2: 1s delay
- Attempt 3: 2s delay
- Each retry gets a fresh browser state (new tab/window)
- Flaky test detection: if a test passes on retry, mark it as "flaky" in the report

**Graceful shutdown:**
- Register handlers for SIGINT, SIGTERM
- Stop dispatching new tests to workers
- Allow in-flight tests to complete (with timeout)
- Kill Safari processes / close tabs
- Flush pending report data to disk
- Exit with appropriate code

### 3.7 Exit Codes

| Code | Meaning |
|---|---|
| 0 | All tests passed |
| 1 | One or more tests failed |
| 2 | Infrastructure/setup error (Safari not available, config invalid, etc.) |

---

## 4. Fixture Serving

### 4.1 Why Fixtures Need a Server

Safari Pilot's test directory already contains HTML fixture files (`dialog-test.html`, `extraction-test.html`, `form-test.html`, `shadow-dom-test.html`, `table-test.html`). These need to be served over HTTP(S) because:

- Safari restricts `file://` URLs (CORS, certain APIs don't work)
- Tests need a realistic HTTP environment
- Dynamic fixtures may need server-side logic
- HTTPS testing requires a proper server with TLS

### 4.2 Architecture: One Server Per Worker

For parallel test isolation, each worker runs its own fixture server:

```
Worker 1 --> Fixture Server :0 (OS assigns port 54321) --> serves test/fixtures/
Worker 2 --> Fixture Server :0 (OS assigns port 54322) --> serves test/fixtures/
Worker 3 --> Fixture Server :0 (OS assigns port 54323) --> serves test/fixtures/
```

**Port allocation:** Bind to port `0` and let the OS assign an ephemeral port. Read the assigned port from `server.address().port`.

```javascript
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createFixtureServer(fixturesDir) {
  const server = createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === '/__health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    const filePath = join(fixturesDir, req.url);
    try {
      const content = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}
```

### 4.3 How Playwright Does It

Playwright's `webServer` config option in `playwright.config.ts`:

```typescript
export default defineConfig({
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

Playwright starts the command, polls the URL for readiness, then runs tests. One server for all workers (not per-worker). Workers share the server but run isolated browser contexts.

**Safari Pilot difference:** Since Safari Pilot tests may share Safari state (no browser context isolation like Playwright), per-worker fixture servers provide stronger isolation. Tests can use their worker's unique base URL to avoid cross-test interference.

### 4.4 HTTPS Fixtures

Safari strictly enforces TLS certificate trust. For HTTPS fixture serving:

1. Generate a self-signed root CA at test startup
2. Sign a leaf certificate for `localhost` and `127.0.0.1` (with SANs)
3. Add the root CA to the macOS System keychain:
   ```bash
   sudo security add-trusted-cert -d -r trustRoot \
     -k /Library/Keychains/System.keychain ca.pem
   ```
4. Use the leaf cert for the fixture server's TLS config
5. Clean up the trusted cert in teardown

**CI implication:** This requires `sudo` on CI. On GitHub Actions hosted runners, this works. On some locked-down self-hosted runners, it may not.

### 4.5 Lifecycle Management

1. **Startup:** Server binds to port 0, starts listening
2. **Readiness probe:** Poll `/__health` endpoint with timeout (default 10s)
3. **URL injection:** Pass `baseUrl` to tests via environment variable or test context
4. **Shutdown:** On SIGINT/SIGTERM, call `server.close()` and drain connections
5. **Cleanup:** Remove any temporary TLS certificates

---

## 5. Screenshot on Failure

### 5.1 Capture Strategy

When a test fails, capture screenshots automatically. Safari Pilot already has `safari_screenshot` as an MCP tool -- the test runner should use this directly.

**What to capture:**
- **Viewport screenshot:** What was visible at the moment of failure (primary diagnostic)
- **Full-page screenshot:** The entire scrollable page (supplementary context)

**When to capture:**
- After assertion failure, before teardown
- After timeout, before force-killing the test
- Optionally: at each test step for a visual timeline (configurable, off by default due to performance cost)

### 5.2 Naming Convention

Use a deterministic, collision-free naming scheme:

```
{suite-name}--{test-name}--{timestamp}--{worker-id}.png
```

Examples:
```
login-tests--should-reject-invalid-password--1712934503--w1.png
checkout--handles-empty-cart--1712934508--w2.png
```

Sanitize suite/test names: replace spaces with hyphens, remove special characters, truncate to 80 chars.

### 5.3 Storage and CI Integration

**Directory structure:**
```
test-results/
  screenshots/
    login-tests--should-reject-invalid-password--1712934503--w1.png
    checkout--handles-empty-cart--1712934508--w2.png
  reports/
    junit.xml
    tap.txt
```

**GitHub Actions artifact upload:**
```yaml
- uses: actions/upload-artifact@v4
  if: always()  # Upload even on failure
  with:
    name: test-results
    path: test-results/
    retention-days: 14
```

### 5.4 Linking Screenshots in Reports

**JUnit XML:**
```xml
<testcase name="should reject invalid password" classname="Login Tests" time="1.3">
  <failure message="Expected 'error' class" type="AssertionError">
    Stack trace here...
  </failure>
  <system-out>
[[ATTACHMENT|test-results/screenshots/login-tests--should-reject-invalid-password--1712934503--w1.png]]
  </system-out>
</testcase>
```

**TAP13:**
```
not ok 2 - should reject invalid password
  ---
  message: "Expected 'error' class"
  severity: fail
  screenshot: test-results/screenshots/login-tests--should-reject-invalid-password--1712934503--w1.png
  duration_ms: 1342
  ...
```

### 5.5 Implementation with Safari Pilot

The test runner hooks into Safari Pilot's existing screenshot capability:

```javascript
// In afterEach hook when test fails
async function captureFailureScreenshot(test, worker, pilot) {
  const timestamp = Math.floor(Date.now() / 1000);
  const safeName = sanitize(test.fullName);
  const filename = `${safeName}--${timestamp}--w${worker.id}.png`;
  const filepath = join(config.screenshotDir, filename);

  // Use Safari Pilot's own screenshot tool
  const result = await pilot.callTool('safari_screenshot', {
    path: filepath,
    fullPage: false,  // Viewport first
  });

  if (result.ok) {
    test.attachments.push({ type: 'screenshot', path: filepath });
  }

  // Optionally capture full page too
  if (config.fullPageScreenshots) {
    const fullPath = filepath.replace('.png', '--full.png');
    await pilot.callTool('safari_screenshot', {
      path: fullPath,
      fullPage: true,
    });
  }
}
```

---

## 6. Parallel Execution

### 6.1 The Safari Concurrency Problem

This is the most architecturally significant challenge for Safari Pilot's test runner.

**safaridriver limitation:** Single session per machine. Period. No workaround.

**Safari Pilot's situation is different but still constrained:**

| Engine | Concurrency Model | Parallel Capability |
|---|---|---|
| AppleScript | `osascript` processes | Multiple `osascript` processes CAN run concurrently, BUT they compete for control of the same Safari application. Commands targeting different tabs/windows can interleave unpredictably. |
| Swift Daemon | Single stdin/stdout process | Single daemon instance by design. Commands are serialized through the daemon's request queue. |
| Safari Web Extension | Native messaging | Single extension instance. Message handling is sequential. |

### 6.2 Parallel Strategies (Ranked by Feasibility)

#### Strategy A: Tab-Level Isolation (Best for Safari Pilot)

Each worker gets its own Safari tab. Tests within a worker run sequentially in that tab.

```
Worker 1 --> Safari Tab 1 (http://127.0.0.1:54321/test-page.html)
Worker 2 --> Safari Tab 2 (http://127.0.0.1:54322/test-page.html)
Worker 3 --> Safari Tab 3 (http://127.0.0.1:54323/test-page.html)
```

**Pros:**
- Safari Pilot's AppleScript engine already supports targeting specific tabs
- Each tab has its own page context
- Per-worker fixture servers provide URL-level isolation

**Cons:**
- AppleScript commands targeting different tabs may race if issued simultaneously
- Safari's JS execution is single-threaded per process (all tabs share the WebContent process for same-origin, but different-origin tabs get separate processes)
- Tab focus changes can interfere with certain operations

**Mitigation:** Serialize AppleScript commands through a mutex/queue. Only one `osascript` process sends commands at a time. Workers queue their commands and wait for a slot.

```javascript
class AppleScriptMutex {
  private queue = [];
  private locked = false;

  async acquire() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
}
```

**Performance impact:** This limits effective parallelism for AppleScript operations. However, between AppleScript commands, workers can do non-Safari work (assertions, data processing, fixture setup) truly in parallel. The bottleneck is Safari interaction, not test logic.

#### Strategy B: Window-Level Isolation

Each worker gets its own Safari window (not just tab).

**Pros:** Stronger visual isolation; some operations are window-scoped.
**Cons:** Same AppleScript serialization issue. More resource-intensive. Safari's window management can be flaky under automation.

**Verdict:** Marginally better than tabs but not worth the added complexity.

#### Strategy C: Process-Level Isolation (Multiple CI Jobs)

Shard tests across multiple macOS CI runner jobs.

```yaml
# GitHub Actions matrix strategy
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    runs-on: macos-15
    steps:
      - run: safari-pilot-test --shard ${{ matrix.shard }}/4
```

**Pros:** True isolation. No contention at all.
**Cons:** 10x cost on macOS runners ($0.08/min vs $0.008/min for Linux). Each job has startup overhead (~2-3 min).

**Verdict:** Use for large test suites or when tab-level isolation proves too flaky. Offer `--shard N/M` CLI flag.

#### Strategy D: Daemon Engine Parallelism

The Swift Daemon could be enhanced to support multiple concurrent sessions (multiplexed over its stdin/stdout or via multiple daemon instances).

**Pros:** Avoids AppleScript entirely. Daemon has sub-millisecond latency.
**Cons:** Requires daemon architecture changes (currently single-session).

**Verdict:** Best long-term path. Worth designing the test runner to support this as a future backend.

### 6.3 Recommended Default: Cooperative Tab Parallelism

Default to `--workers 1` (serial execution) for reliability. Allow `--workers N` with the tab-isolation strategy and AppleScript mutex. Document that `--workers` > 1 is experimental and may have flakiness.

For CI, recommend the matrix sharding strategy (Strategy C) for production reliability.

### 6.4 How Playwright Handles Parallelism (Reference)

Playwright's approach for comparison:

- `fullyParallel: true` runs all tests concurrently
- Workers are separate Node.js processes (not threads)
- Each worker gets its own browser context (isolated cookies, storage)
- Sharding: `--shard=1/4` divides test files across CI jobs
- Default: number of workers = half of CPU cores

Playwright's model works because it controls the browser engine directly and can create isolated contexts. Safari Pilot controls the real Safari application, which is inherently shared state. This is a fundamental architectural difference.

### 6.5 Resource Contention Risks

| Resource | Contention Risk | Mitigation |
|---|---|---|
| AppleScript commands | Multiple `osascript` processes racing | Mutex/queue (see above) |
| Safari focus/frontmost | Only one window/tab can be focused | Avoid operations requiring focus; use tab-targeted commands |
| TCC permission prompts | Only one prompt can be active | Pre-grant all permissions; never trigger prompts during tests |
| CPU/memory | Multiple tabs loading simultaneously | Limit worker count; add delays between heavy operations |
| Fixture server ports | Port collisions | Always use port 0 (OS-assigned ephemeral ports) |

---

## 7. Headless Safari

### 7.1 Native Headless Mode: Does Not Exist

**Apple's `safaridriver` does not support headless mode.** This is a deliberate design choice, not a missing feature. Safari is a native macOS application that requires the WindowServer (GUI session) to render content.

> "Safari driver does not support a headless mode." -- Apple Developer Documentation

This means:
- Any CI job running Safari tests needs a full macOS VM with a logged-in user session
- No `Xvfb` equivalent exists for macOS (Xvfb is X11-specific; macOS uses Quartz/WindowServer)
- The test requires a display, even if no human is watching

### 7.2 Workarounds for "Headless-Like" Behavior

While true headless is impossible, tests can run without stealing user focus:

1. **Minimize Safari windows:** Tests can run in minimized windows. Most operations work (DOM manipulation, JS execution, network requests). Some operations that require visual rendering (screenshots, visual assertions) may produce blank results.

2. **Run in background:** Safari can execute in non-frontmost position. AppleScript commands still work because they target Safari by name, not by focus.

3. **Separate user session:** On self-hosted runners, create a dedicated user account that auto-logs in. Tests run in that user's GUI session, invisible to the primary user.

### 7.3 WebKit Headless (Playwright's Approach)

Playwright's "WebKit" browser is NOT Safari. It is a custom build of the WebKit engine that:
- Runs headlessly without WindowServer
- Has its own process architecture separate from Safari.app
- Does NOT include Safari-specific behaviors (ITP, extensions, Keychain integration)
- May differ in rendering from the shipping Safari

**For Safari Pilot, this is not an option.** Safari Pilot's value proposition is controlling the REAL Safari with real user sessions. Using Playwright's WebKit would defeat the purpose.

### 7.4 Impact on CI Architecture

| Environment | Headless Possible? | Recommendation |
|---|---|---|
| GitHub Actions macOS runners | N/A (GUI session provided) | Works as-is. Safari runs in the runner's logged-in desktop session. |
| CircleCI macOS | N/A (GUI session provided) | Works as-is. |
| Self-hosted Mac Mini/Pro | Requires auto-login user | Configure auto-login; optionally use a secondary user account. |
| Docker/Linux | **Not possible** | Safari Pilot is macOS-only. This is an inherent platform constraint. |

**Key takeaway for CI design:** Safari Pilot tests ALWAYS need a macOS runner with a GUI session. There is no Linux/Docker/headless path. This constrains CI to macOS runners, which are ~10x more expensive than Linux runners. The test runner should be designed to minimize wall-clock time on macOS runners (fast fixture serving, efficient test execution, smart parallelism).

---

## 8. Architecture Recommendations for Safari Pilot

### 8.1 Summary of Key Design Decisions

| Decision | Recommendation | Rationale |
|---|---|---|
| Runner type | Standalone CLI (`safari-pilot-test`) | Not coupled to any test framework; manages full Safari lifecycle |
| Primary report format | JUnit XML (default) | Universal CI support; screenshot attachments via `[[ATTACHMENT|...]]` |
| Secondary report format | TAP13 (optional) | Good for terminal streaming and piping |
| Fixture serving | Built-in, one server per worker | Zero-config; port 0 for automatic allocation |
| Screenshots | Automatic on failure via Safari Pilot's own tools | Full integration; both viewport and full-page |
| Parallelism default | Serial (`--workers 1`) | Reliable baseline; tab-level parallelism as opt-in |
| Parallelism strategy | Tab isolation + AppleScript mutex | Best balance for Safari Pilot's architecture |
| CI sharding | `--shard N/M` flag | For matrix-based parallelism across CI jobs |
| Headless | Not supported; document requirement for GUI session | Inherent Safari limitation; no workaround exists |
| Retry strategy | Configurable retries with exponential backoff | Essential for Safari testing flakiness |
| Exit codes | 0=pass, 1=fail, 2=infra error | Standard CI convention |

### 8.2 Minimum Viable Implementation

Phase 1 (MVP -- 2 sessions):
1. CLI entry point with config loading
2. Test discovery (glob-based)
3. Serial test execution using Safari Pilot tools
4. JUnit XML reporter
5. Screenshot on failure
6. Basic fixture server (single instance, port 0)

Phase 2 (Parallel + Polish -- 1-2 sessions):
1. TAP reporter
2. Worker pool with tab-level isolation
3. Per-worker fixture servers
4. Retry with backoff
5. `--shard N/M` flag
6. Console reporter with progress bar

Phase 3 (CI Integration -- 1 session):
1. GitHub Actions workflow template
2. Example `.github/workflows/safari-test.yml`
3. CircleCI config example
4. Artifact upload patterns
5. CI-native annotations (`::error` for GitHub Actions)

### 8.3 Test File Format

Tests should be plain JavaScript/TypeScript files that export test functions. The runner provides Safari Pilot as a fixture:

```javascript
// tests/login.test.js
export default {
  name: 'Login Tests',

  async 'should display login form'(pilot, { baseUrl }) {
    await pilot.callTool('safari_navigate', { url: `${baseUrl}/form-test.html` });
    const snapshot = await pilot.callTool('safari_snapshot', {});
    assert(snapshot.text.includes('form'), 'Form should be present');
  },

  async 'should reject invalid password'(pilot, { baseUrl }) {
    await pilot.callTool('safari_navigate', { url: `${baseUrl}/form-test.html` });
    await pilot.callTool('safari_fill', { selector: '#password', value: 'wrong' });
    await pilot.callTool('safari_click', { selector: '#submit' });
    await pilot.callTool('safari_wait_for', { selector: '.error', timeout: 5000 });
  },
};
```

### 8.4 GitHub Actions Workflow Template

```yaml
name: Safari Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: macos-15  # Pinned version, NOT macos-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm ci

      # Enable Safari automation
      - name: Enable safaridriver
        run: sudo safaridriver --enable

      # Run tests
      - name: Run Safari Pilot tests
        run: npx safari-pilot-test --reporter junit --output test-results/junit.xml --screenshot-on-failure --screenshot-dir test-results/screenshots

      # Upload results (always, even on failure)
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: test-results/
          retention-days: 14

      # Parse JUnit XML for GitHub UI integration
      - name: Publish Test Results
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Safari Tests
          path: test-results/junit.xml
          reporter: java-junit
```

### 8.5 Open Questions for Implementation

1. **Should the test runner use Safari Pilot's MCP server or call engines directly?** Using MCP maintains the security pipeline but adds overhead. Calling engines directly is faster but bypasses rate limiting, circuit breakers, etc. Recommendation: provide both modes (`--direct-engine` flag to bypass MCP for trusted CI environments).

2. **How to handle Safari Pilot's three engine tiers in tests?** The engine selector auto-picks the best available engine. In CI, the daemon may not be compiled, and the extension may not be installed. Tests should specify required engine tier or gracefully degrade.

3. **Should the test runner manage Safari lifecycle (launch/quit)?** On CI, Safari should be launched fresh for each test run and quit afterward. On local dev, the user may want Safari to stay open. Config option: `manageSafari: true` (default in CI, false locally).

4. **Fixture server: static only or support dynamic routes?** Static serving covers most cases. Dynamic fixtures (server-side rendering, API mocking) would need a middleware system. Start with static; add middleware in a future iteration.

---

## Sources

1. [GitHub Actions Runner Images: macos-15-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)
2. [GitHub Actions Runner Images: macos-14-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-14-Readme.md)
3. [WebKit Blog: WebDriver Support in Safari 10](https://webkit.org/blog/6900/webdriver-support-in-safari-10/)
4. [Apple Developer: Testing with WebDriver in Safari](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)
5. [CircleCI: Enabling safaridriver support on macOS](https://support.circleci.com/hc/en-us/articles/360056461992-Enabling-safaridriver-support-on-macOS)
6. [testmoapp/junitxml: JUnit XML format specification](https://github.com/testmoapp/junitxml)
7. [StackOverflow: JUnit XML format specification](https://stackoverflow.com/questions/4922867/what-is-the-junit-xml-format-specification-that-hudson-supports)
8. [TAP v13 Specification](https://testanything.org/tap-version-13-specification.html)
9. [Playwright: Parallelism and Sharding](https://playwright.dev/docs/test-parallel)
10. [Playwright: Web Server Configuration](https://playwright.dev/docs/test-webserver)
11. [Selenium: Safari-Specific Functionality](https://www.selenium.dev/documentation/webdriver/browsers/safari/)
12. [Microsoft Playwright GitHub Repository](https://github.com/microsoft/playwright)
13. [SeleniumHQ/selenium GitHub Repository](https://github.com/SeleniumHQ/selenium)
14. [StackOverflow: macOS Sierra - Enable Allow Remote Automation via CLI](https://stackoverflow.com/questions/41629592/macos-sierra-how-to-enable-allow-remote-automation-using-command-line)
15. [Apple Developer Forums: Allow Javascript from Apple Events](https://developer.apple.com/forums/thread/100414)
16. [Apple Safari User Guide: Develop Menu](https://support.apple.com/guide/safari/use-the-developer-tools-in-the-develop-menu-sfri20948/mac)
