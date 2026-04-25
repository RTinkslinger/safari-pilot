# Executive Summary

To refactor the E2E test architecture from a 'server-per-test-file' to a 'server-per-test-run' model, the recommended approach is to leverage Vitest's global lifecycle hooks. A single, long-lived server process should be spawned within the `globalSetup` function before any tests are executed. This function will also define a corresponding `teardown` method, which Vitest will invoke after all tests complete to ensure the server process is terminated cleanly. Test-level isolation, which is critical when sharing a server instance, is then managed by the browser automation framework. By adopting Playwright's model, each test should be executed within a new, isolated 'Browser Context'. This practice prevents state leakage (e.g., cookies, local storage) between tests, effectively providing a clean slate for each test run while efficiently interacting with the single, shared server instance. This architecture directly mirrors the production lifecycle, improves test suite performance by eliminating redundant server startups, and provides robust isolation.

# Recommended Architecture Overview

The proposed architecture integrates Vitest for test orchestration and process management with a browser automation framework like Playwright for test execution and isolation. The core principle is to decouple the server's lifecycle from the individual test's lifecycle.

1.  **Server Lifecycle Management (Vitest):**
    *   **`globalSetup`:** In your `vitest.config.ts`, you will define a `globalSetup` file. This file exports an asynchronous function that is executed once before the entire test suite runs. Inside this function, you will use Node.js's `child_process.spawn` to start your MCP server as a long-lived daemon process. You will need to manage its `stdio` and capture its process ID (PID).
    *   **State Communication:** Since `globalSetup` runs in a separate process from the test workers, you must establish a communication channel. A common pattern is to have the `globalSetup` function write the server's PID and any other necessary connection details (e.g., a port number if applicable) to a temporary file. Test files can then read this file to connect to the correct server instance.
    *   **`globalTeardown`:** The `globalSetup` function should return a `teardown` function. Vitest guarantees this function will be executed once after all tests have finished, even in watch mode or on abort (e.g., via SIGTERM). This teardown function is responsible for gracefully terminating the server process using its stored PID (e.g., `process.kill(pid)`), preventing orphaned processes.

2.  **Test Isolation (Playwright):**
    *   **Shared Browser, Isolated Contexts:** Playwright is optimized to run a single browser instance for the entire test run to save resources. However, it achieves test isolation through 'Browser Contexts'.
    *   **Per-Test Context:** For each test (or test file, depending on the desired isolation level), you will create a new `browser.newContext()`. A browser context is a completely isolated environment, equivalent to a new browser profile. It has its own cookies, local storage, and session data. This ensures that actions performed in one test (like logging in or setting a value in storage) do not affect any other test.
    *   **Fixtures and Cleanup:** Playwright's test runner automatically manages the lifecycle of these contexts and their associated pages. When a test completes, the context and all its pages are destroyed, guaranteeing a clean slate for the next test and preventing state leakage.

# Playwright Isolation Model Analysis

## Browser Lifecycle Strategy

Playwright's strategy prioritizes efficiency by avoiding the high cost of launching a new browser process for every test. Instead, it typically launches a single browser instance (e.g., Chromium, Firefox, WebKit) at the beginning of a test run. This single, long-lived browser process is then shared across all tests within that run, significantly reducing overhead and speeding up execution.

## Context Isolation Pattern

The cornerstone of Playwright's isolation model is the 'Browser Context'. A Browser Context is an isolated, incognito-like session within the shared browser instance. Each context has its own independent set of cookies, local storage, session storage, and permissions. Playwright's test runner automatically creates a new browser context for each test file, ensuring that tests in different files cannot influence each other. This prevents common E2E testing problems like authentication state from one test leaking into another. This model allows for full test isolation without the performance penalty of creating a new browser process for each test.

## Page And Fixture Scoping

Within a browser context, Playwright's test runner provides even finer-grained isolation at the individual test level through fixtures. The default `page` fixture, for example, is scoped to a single test. This means that for each `test()` function, Playwright creates a new, clean page (or tab) and passes it to the test. After the test completes (whether it passes or fails), the page is automatically closed and cleaned up. This ensures that every test starts with a fresh page, free from any state or DOM modifications left by previous tests, providing a reliable and reproducible environment.


# Vitest Global Lifecycle Implementation Guide

## Global Setup Role

The `globalSetup` function in Vitest is designed for one-time initialization tasks that must occur before any test files are executed. Its primary purpose in this architecture is to spawn the shared server process. You configure this in `vitest.config.ts` by providing a path to a setup file. This file should export an async function, `setup`, which will contain the logic to start your server (e.g., using `spawn`). This function is executed only once per test run, solving the core problem of avoiding a server spawn for each test file.

## Global Teardown Role

Vitest provides a clean and guaranteed teardown mechanism by allowing the `globalSetup` function to return a teardown function. Vitest's test runner will automatically invoke this returned function after all tests have completed. The role of this `globalTeardown` function is to perform cleanup, most critically, to gracefully terminate the server process that was started in `globalSetup`. This ensures that no zombie or orphaned processes are left running after the test suite finishes, which is essential for CI/CD environments. The documentation confirms this function is called before the process exits, even in watch mode.

## State Communication Method

Because `globalSetup` runs in a separate context from the test worker processes, direct memory sharing (like setting `global.myServer`) is not possible. The canonical pattern for communicating state, such as the server's process ID (PID) or a dynamically assigned port, is through the filesystem. The `globalSetup` function should write the necessary details into a well-known temporary file (e.g., `path.join(os.tmpdir(), 'my-test-server.json')`). Then, within each test file (or a per-file setup hook like `beforeAll`), the test worker can read this file to retrieve the connection information needed to communicate with the shared server instance.


# Global Setup Script

To implement a shared server for your entire test suite, you create a `globalSetup` file. This file exports an asynchronous `setup` function that Vitest executes once before any tests start.

**Key Steps in `globalSetup`:**
1.  **Spawn the Server:** Use Node.js's `child_process.spawn` to start your server script (e.g., `dist/index.js`). It's crucial to run it in `detached` mode and pipe its `stdio` so you can monitor its output and control its lifecycle independently of the main Vitest process.
2.  **Wait for Readiness:** Do not allow tests to start until the server is ready. This is achieved by creating a `Promise` that listens to the server process's `stdout`. The promise resolves when it detects a specific string that your server logs upon successful startup (e.g., 'Server is ready and listening'). This prevents race conditions where tests try to connect to a server that hasn't finished initializing.
3.  **Store the PID:** The Process ID (PID) of the spawned server is essential for teardown. The most reliable way to pass it to the teardown logic is by storing it. A simple method is to set an environment variable, like `process.env.SERVER_PID = serverProcess.pid.toString()`, which can be accessed later.
4.  **Return a Teardown Function:** The modern Vitest pattern is for the `setup` function to return another async function. This returned function is your teardown logic. Vitest will automatically execute it after all tests have completed. This is superior to a separate `globalTeardown` file because it can access variables from the `setup` function's scope via closure, making state management simpler.

**Example `globalSetup` file (`./tests/setup.ts`):**
```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// This function will be executed once before all tests
export async function setup() {
  console.log('Starting shared server for E2E tests...');

  const serverPath = path.resolve(process.cwd(), 'dist/index.js');
  const serverProcess = spawn('node', [serverPath], {
    stdio: 'pipe', // We need to listen to stdout to know when it's ready
    detached: true, // Allows us to kill the process group reliably
  });

  // Store the PID in an environment variable to be accessed in teardown
  if (serverProcess.pid) {
    process.env.SERVER_PID = serverProcess.pid.toString();
  }

  // Wait for the server to log that it is ready
  await new Promise<void>((resolve, reject) => {
    const startupTimeout = setTimeout(() => {
      reject(new Error('Server startup timed out after 30 seconds.'));
    }, 30000);

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Server STDOUT]: ${output}`);
      // IMPORTANT: Adjust this string to match your server's actual ready message
      if (output.includes('Server ready')) {
        clearTimeout(startupTimeout);
        console.log('Shared server is ready.');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Server STDERR]: ${data.toString()}`);
    });
  });

  // Return the teardown function
  return async () => {
    console.log('Tearing down shared server...');
    const pid = process.env.SERVER_PID ? parseInt(process.env.SERVER_PID, 10) : null;

    if (pid) {
      try {
        // Kill the entire process group by passing the negative PID
        // This ensures any child processes spawned by the server are also terminated
        process.kill(-pid, 'SIGTERM');
        console.log(`Sent SIGTERM to process group ${pid}.`);
      } catch (e) {
        console.error(`Failed to terminate server process group ${pid}:`, e);
      }
    }
  };
}
```

# Global Teardown Script

The most robust and modern way to handle teardown in Vitest is to have your `globalSetup` function return the teardown logic as another function. Vitest guarantees that this returned function will be executed once after all test suites have finished running, even if the test run is aborted (e.g., via Ctrl+C, which sends a `SIGTERM` signal).

**Key Steps in Teardown Logic:**
1.  **Retrieve the PID:** The teardown function needs the PID of the server process it's supposed to terminate. By returning the teardown function from `setup`, it can access the `pid` stored in an environment variable (`process.env.SERVER_PID`) during the setup phase.
2.  **Terminate the Process:** The standard way to gracefully shut down a Node.js process is by sending it a `SIGTERM` signal. The `process.kill()` method is used for this. It's crucial to handle potential errors, such as the process already having been terminated.
3.  **Kill the Process Group:** When a server is spawned with the `{ detached: true }` option, it becomes the leader of a new process group. To ensure that the server and any of its own subprocesses are cleaned up, you should send the signal to the entire process group. This is done by passing the *negative* value of the PID to `process.kill()`. For example, `process.kill(-pid, 'SIGTERM')`.

**Example Teardown Function (as returned from `globalSetup`):**

This code is part of the `setup.ts` file shown previously and is returned at the end of the `setup` function.

```typescript
// This function is returned by the `setup` function.
// Vitest will execute it after all tests complete.
async () => {
  console.log('Tearing down shared server...');
  const pidStr = process.env.SERVER_PID;

  if (!pidStr) {
    console.warn('Server PID not found, cannot perform teardown.');
    return;
  }

  const pid = parseInt(pidStr, 10);

  try {
    // By using the negative PID, we signal the entire process group.
    // This is crucial for ensuring that any child processes spawned by your server
    // are also terminated, preventing orphaned processes.
    // This requires the `detached: true` option in `spawn`.
    process.kill(-pid, 'SIGTERM');
    console.log(`Successfully sent SIGTERM to process group ${pid}.`);
  } catch (error) {
    // It's possible the process has already exited, which can throw an error.
    // We log this as a warning rather than a critical failure.
    if (error.code === 'ESRCH') {
      console.warn(`Process group ${pid} not found. It may have already been terminated.`);
    } else {
      console.error(`Failed to terminate server process group ${pid}:`, error);
    }
  }
};
```
This pattern ensures that your server process is reliably terminated, preventing it from becoming a zombie process after the test run is complete.

# Communicating Server Details To Tests

Since `globalSetup` runs in the main Vitest process and your tests run in isolated worker processes, you cannot share state via in-memory variables. You must use a mechanism that can cross process boundaries. Here are the common strategies:

**1. Environment Variables (Recommended)**

This is the simplest and most common approach. The `globalSetup` script writes server details to `process.env`, and the test files read them back.

*   **In `globalSetup` (`setup.ts`):**
    After the server starts and you determine its port (e.g., by parsing stdout), you expose it:

    ```typescript
    // Assuming the server logs something like "Server listening on port 34567"
    serverProcess.stdout.on('data', (data) => {
      const match = data.toString().match(/listening on port (\d+)/);
      if (match && match[1]) {
        const port = match[1];
        process.env.SERVER_PORT = port;
        console.log(`Server port ${port} exposed to tests via environment variable.`);
        resolve();
      }
    });
    ```

*   **In your test file (`*.test.ts`):**
    Your test can now access this port to make requests.

    ```typescript
    import { test, expect } from 'vitest';

    test('should connect to the shared server', async () => {
      const port = process.env.SERVER_PORT;
      expect(port).toBeDefined();

      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.status).toBe(200);
    });
    ```

**2. Temporary File**

This method is useful if you need to share more complex state than simple strings. The `globalSetup` function writes a JSON file to a temporary directory, and tests read from it.

*   **In `globalSetup`:**

    ```typescript
    import fs from 'fs/promises';
    import path from 'path';
    import os from 'os';

    const stateFilePath = path.join(os.tmpdir(), 'vitest_e2e_state.json');
    const serverState = { port: 34567, pid: serverProcess.pid };
    await fs.writeFile(stateFilePath, JSON.stringify(serverState));
    // Also store the path for the teardown function to find and delete the file
    process.env.STATE_FILE_PATH = stateFilePath;
    ```

*   **In your test file:**

    ```typescript
    import fs from 'fs/promises';
    import path from 'path';
    import os from 'os';

    const stateFilePath = path.join(os.tmpdir(), 'vitest_e2e_state.json');
    const serverState = JSON.parse(await fs.readFile(stateFilePath, 'utf-8'));
    const port = serverState.port;
    // ... use the port
    ```
    The teardown function would be responsible for deleting this file.

For the user's case with an `stdio`-based MCP server, where there might not be a port, the primary piece of information to communicate is simply that the server is *running*. The `globalSetup` ensures this before any tests start. The tests themselves would then use the client-side logic (e.g., the Safari extension) which is presumably configured to know how to connect to the stdio-based server, so no dynamic information needs to be passed.

# Intra Fixture Isolation Best Practices

To ensure test isolation within a shared server fixture, especially for an MCP server managed across a test suite, you should adopt practices inspired by frameworks like Playwright. The core challenge is that while the browser can be isolated per test using contexts, the single server instance is a shared resource that is not inherently aware of individual tests.

Here are the best practices:

1.  **Lifecycle Management with `globalSetup`/`globalTeardown`**: Use your test runner's global setup feature (e.g., `globalSetup` in Vitest) to spawn the server process *once* at the beginning of the entire test run. This function should capture the process's `stdio` and make it available to all test files, for instance by writing the PID and port to a temporary file or exporting them. The `globalSetup` should return a `teardown` function. This returned function, which Vitest will execute on exit (including upon receiving `SIGTERM`), is responsible for cleanly terminating the server process. This correctly models the production lifecycle of one server per session.

2.  **Unique-Per-Test Identifiers for State Isolation**: Since the server state is shared, each test must operate within its own logical namespace to prevent collisions. Before a test runs (e.g., in a `beforeEach` hook or at the start of the test function), generate a unique identifier (like a UUID). This identifier should be used to prefix or tag any state created on the server during that test. For example, if a test creates a document, it might be named `test-a1b2c3d4-mydoc`. This ensures that even if tests run in parallel, they won't read or write each other's data.

3.  **Robust Cleanup-on-Failure Logic**: State leakage from failed or incomplete tests is a major source of flakiness. The most reliable way to ensure cleanup is to use the test framework's teardown hooks. 
    *   **`afterEach` Hooks**: Place all cleanup logic in an `afterEach` hook. This hook will run after every test in a file, regardless of whether the test passed or failed. The cleanup logic should use the unique identifier generated for the test to find and remove all resources it created.
    *   **`try...finally`**: While `afterEach` is generally preferred for its robustness, a `try...finally` block within the test itself can also enforce cleanup. The test logic runs in the `try` block, and the cleanup code runs in the `finally` block. This is less ideal as it requires boilerplate in every test and might be missed by developers.

4.  **Browser-Level Isolation (Playwright Model)**: Emulate Playwright's isolation model. While you have one shared server, you should use a new `BrowserContext` for each test. As the search results indicate, Playwright's browser contexts are isolated environments that do not share cookies, local storage, or sessions. This prevents test side-effects on the client side. Each test should create a new context and a new page (or tab), perform its actions, and then close the context in its cleanup step. This maps well to the user's goal of per-test tab-level isolation.

5.  **Coordination for Parallel Tests**: If tests absolutely must interact with a truly global, non-isolatable resource (e.g., a system-wide setting), they cannot run in parallel without explicit coordination. However, the primary goal should be to design tests that are fully independent. If coordination is unavoidable, mechanisms like file-based locks can be used to ensure only one test manipulates the shared global resource at a time. This should be a last resort.

# Test Strategy Unit Vs E2E

For a project shipping a native app (like a Safari extension) and a server (like an MCP server), the right split between unit and end-to-end (E2E) tests is crucial for maintaining development velocity and ensuring system reliability. The strategy should follow the testing pyramid model: a large base of fast unit tests and a smaller, more focused set of comprehensive E2E tests.

**Unit Tests:**
*   **Purpose**: To verify the correctness of individual functions, modules, or components in isolation.
*   **Scope**: They should be in-process, extremely fast, and have no external dependencies like networks or filesystems. All boundaries, such as the stdio communication protocol or native browser APIs, should be mocked. For the server, you would test a function by passing it data directly and asserting on its return value, without ever spawning the server process. For the native extension, you would test UI logic or data transformation functions without a real browser or server.
*   **Volume**: You should have many unit tests covering as much of the individual component logic as possible, including edge cases and error handling.

**End-to-End (E2E) Tests:**
*   **Purpose**: To verify that the entire system works together as it does in production. This is where you gain confidence that the integration between the native app and the server is solid.
*   **Scope**: E2E tests should be as realistic as possible. This means:
    *   Spawning the **real server process**.
    *   Using the **real communication protocol** (e.g., stdio) between the client and server.
    *   Running the test against the **real target environment** (e.g., automating the actual Safari browser with the extension installed).
    *   Focusing on critical user journeys and workflows, such as the initial connection, sending a request, and receiving a response that correctly manipulates the browser.
*   **Volume**: You should have fewer E2E tests than unit tests. They are inherently slower and more brittle, so they should be reserved for validating critical paths and integration points that cannot be verified with unit tests.

**Anti-Patterns to Avoid:**
*   **Mock-Heavy 'Integration' Tests**: Creating tests that spawn a real server but then mock its communication or the browser's behavior. These tests provide a false sense of security as they are not truly testing the end-to-end integration.
*   **E2E Tests for Unit-Level Logic**: Writing slow E2E tests to check business logic that could have been checked with a fast unit test. For example, using a full browser test to verify a data transformation function.
*   **Divergence from Production**: Any deviation in the E2E test setup from the production environment reduces the value of the test. This includes the user's identified anti-pattern of spawning a new server for each test file, which does not match how a session-based server runs in production.

# Scope Of Unit Tests

The ideal scope for unit tests in a project involving a server and a native client is to be tightly focused on a single 'unit' of work, which could be a function, a class, or a module. The defining characteristics of a proper unit test are:

*   **In-Process**: Unit tests run within the same process as the test runner. For the MCP server, this means you would import a function from your server's codebase directly into your test file and call it. You would *not* use `spawn` to start the server as a separate process.

*   **Fast**: A single unit test should execute in milliseconds. A full suite of hundreds or thousands of unit tests should complete in seconds. This speed is critical for providing rapid feedback to developers, especially when run automatically on every code change.

*   **Focused and Isolated**: A unit test should validate one specific piece of logic. To achieve this isolation, all external dependencies and boundaries must be replaced with 'test doubles' like mocks, stubs, or fakes.
    *   **For the Server**: When testing a function that is supposed to write a message to `stdout`, you would mock the `process.stdout.write` function and assert that it was called with the expected message. You would not check the actual console output.
    *   **For the Native Integration**: When testing a part of the Safari extension, you would mock the browser APIs (`chrome.*` or `browser.*` APIs) to simulate responses from the browser, and you would mock the module responsible for communicating with the MCP server. This allows you to test the extension's logic (e.g., 'if the server sends message X, does the extension call browser API Y?') without needing a real browser or server.

# Scope Of E2E Tests

The ideal scope for end-to-end (E2E) tests is to validate the system as a complete, integrated whole, simulating a real user's workflow from start to finish. For a system comprising a native app and a server, this means testing the entire stack with as few mocks as possible.

*   **Real Processes**: The E2E test harness must launch the server as a real, separate process, exactly as it would be launched in production (e.g., `spawn('node', ['dist/index.js'])`). This validates that the server can start up correctly, manage its resources, and be terminated cleanly. The goal is to have one server process for the entire test run, managed by a global setup fixture.

*   **Real Communication Protocol**: The test must use the actual communication channel that the client and server use in production. In this case, it's the `stdio` protocol. The test client (the automated browser extension) should send messages to the server's `stdin` and listen for responses on its `stdout`, verifying that the data is serialized, transmitted, and deserialized correctly.

*   **Real Target Environment**: The test must execute against the final, real-world environment. For a Safari extension, this means the tests must programmatically launch and control the Safari browser, install the actual extension, and interact with web pages through it. This validates everything from UI interactions in the browser to the extension's ability to correctly use native browser APIs and communicate with the background server process.

In essence, an E2E test should replicate a user story. For example: 'When the user opens Safari, the MCP server starts. When the user navigates to a specific page and clicks the extension's button, the extension sends a message to the server via stdio, the server processes it and replies, and the extension then highlights an element on the page.' Testing this entire flow is the core responsibility of the E2E suite.

# E2E Testing Anti Patterns

## Anti Pattern

Spawning a new server process per test file

## Negative Impact

This is the primary issue described in the user's query. It is highly inefficient, as the startup cost of the server (including launching native components like a Safari window) is incurred for every single test file. This dramatically slows down the entire test suite. Furthermore, it creates an unrealistic test environment that does not match the production lifecycle, where a single, long-lived server process handles many requests or sessions. This divergence can hide bugs related to memory leaks, state corruption over time, or resource handling in a long-running process.

## Recommended Alternative

Use a single, long-lived server process for the entire test run. This process should be started once before any tests begin and terminated after all tests have completed. Test runners like Vitest provide `globalSetup` and `globalTeardown` hooks specifically for this purpose. This approach accurately mimics the production environment and significantly improves test execution speed.

## Anti Pattern

Mock-heavy 'integration' tests that don't use real processes

## Negative Impact

When end-to-end or integration tests rely heavily on mocks for external components (like the server process itself), they cease to be true integration tests. They verify that the code works with the mock, not with the actual dependency. This creates a false sense of security and can lead to production failures when the real components interact, as the contract assumed by the mock may be subtly different from the real implementation. The test is no longer 'end-to-end'.

## Recommended Alternative

End-to-end tests should, by definition, use real processes, real network protocols (or stdio in this case), and real dependencies wherever possible. Mocks should be reserved for pure unit tests, where the goal is to isolate a single unit of code. For E2E tests, the focus should be on verifying the entire system stack, from the client (the test) to the server and its integrated components.

## Anti Pattern

Reusing browser contexts or pages across independent tests

## Negative Impact

Sharing stateful browser objects like pages or contexts between unrelated tests breaks test isolation. State from one test (e.g., cookies, local storage, authenticated sessions, opened tabs) can leak into subsequent tests, causing unpredictable behavior and flaky failures that are hard to debug. A failing test might leave the shared context in a bad state, causing a cascade of failures in other, unrelated tests.

## Recommended Alternative

Leverage the architecture provided by modern testing frameworks like Playwright. The best practice is to create a new, pristine `BrowserContext` for each test file or even each individual test. Playwright's fixture model is designed to do this automatically, providing a clean `page` or `context` to every test, ensuring they run in a completely isolated environment. This improves reliability and reproducibility.

## Anti Pattern

Using a separate health-probe server in globalSetup

## Negative Impact

Spawning a secondary, simplified server just to check if the environment is ready adds unnecessary complexity and is another point of potential failure. It also doesn't guarantee that the *actual* application server is ready to accept connections, only that a similar process can be started. The test should verify the readiness of the actual system under test.

## Recommended Alternative

The `globalSetup` script should spawn the main application server. After spawning, the script should include a polling mechanism (e.g., a loop with a timeout) that attempts to connect to the server or checks for a specific log output on `stdout` (like 'Server listening on...'). The `globalSetup` function should only resolve its promise once the main server is confirmed to be ready, ensuring all subsequent tests start with a healthy system.


# Refactoring Action Plan

## Step Number

1.0

## Action

Implement `globalSetup` and `globalTeardown` for Server Lifecycle Management

## Details

Create a file, for example `tests/globalSetup.ts`, and configure it in your `vitest.config.ts`. This file will manage the lifecycle of your MCP server.

**1. Configure Vitest:**
In `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './tests/globalSetup.ts',
  },
});
```

**2. Implement the Setup and Teardown Logic:**
In `tests/globalSetup.ts`:
```typescript
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';

let serverProcess: ChildProcess;

export async function setup() {
  console.log('Starting global MCP server...');
  serverProcess = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'], // Ensure stdio is piped
    detached: true, // Important for clean process group termination
  });

  // Store PID for teardown and communication
  await fs.writeFile('.test-server-info.json', JSON.stringify({ pid: serverProcess.pid }));

  // Wait for the server to be ready by listening to its stdout
  await new Promise<void>((resolve, reject) => {
    serverProcess.stdout?.on('data', (data) => {
      if (data.toString().includes('Server ready')) { // Adjust to your server's ready message
        console.log('Global MCP server is ready.');
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error(`Server stderr: ${data}`);
    });

    // Timeout if the server doesn't start in time
    setTimeout(() => reject(new Error('Server startup timed out')), 30000);
  });

  // The teardown function is returned from setup
  return async () => {
    console.log('Tearing down global MCP server...');
    if (serverProcess && serverProcess.pid) {
      // Use process group killing to ensure child processes are also terminated
      process.kill(-serverProcess.pid, 'SIGTERM');
    }
    await fs.unlink('.test-server-info.json').catch(() => {}); // Clean up the info file
    console.log('Global MCP server torn down.');
  };
}
```
This script starts the server, waits for a readiness signal, and returns a teardown function that will be automatically called by Vitest on exit (including `SIGTERM`/`Ctrl+C`).


# Vitest Config Example

To make Vitest aware of your global setup file, you need to reference it in your `vitest.config.ts` (or `vite.config.ts`) file. You use the `globalSetup` property within the `test` configuration object.

It is also a best practice to increase the default test timeout, as end-to-end tests involving server startup and browser automation can take longer than typical unit tests.

Here is a concrete example of what your `vitest.config.ts` should look like:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Path to your global setup file.
    // Vitest will run this file once before all of your tests.
    globalSetup: './tests/setup.ts',

    // E2E tests can be slow. It's good practice to set a generous timeout
    // to prevent tests from failing due to slow server startup or network latency.
    // This timeout is in milliseconds (e.g., 60000ms = 1 minute).
    testTimeout: 60000,

    // For E2E tests that involve a server, it's often necessary to run tests serially
    // to prevent them from interfering with each other's state on the server.
    // You can do this globally or per-file with the --threads=false CLI flag or config.
    // Forcing serial execution in the config:
    threads: false,

    // Alternatively, if your tests are designed for parallelism but you want to ensure
    // all tests in a single file run serially, you can use a comment at the top of the file:
    // /** @vitest-environment-options { "threads": false } */
  },
});
```

**Key Configuration Points:**

*   **`globalSetup`**: This property takes a string which is the path to the file containing your `setup` function. The path is relative to your project root.
*   **`testTimeout`**: A global timeout for all tests. This is important for E2E tests to avoid premature failures.
*   **`threads: false`**: This forces all test files to run one after another, which can be essential for E2E tests that modify a shared state on the single server instance. If your tests are designed to be isolated and can run in parallel against the shared server, you can omit this.

# Documentation And Oss References

## Title

Vitest Config: globalSetup

## Url

https://vitest.dev/config/globalsetup

## Resource Type

Official Documentation

## Relevance

This is the primary documentation for the feature that enables the entire recommended architecture. It explains how to define a global setup file that runs once before all tests, which is the correct place to spawn a shared server process. It also mentions the teardown function.

## Title

Vitest Guide: Test Run Lifecycle

## Url

https://vitest.dev/guide/lifecycle

## Resource Type

Official Documentation

## Relevance

This document clarifies when the global setup and teardown functions are executed in the test lifecycle. It confirms that the teardown function runs after all tests are complete, ensuring the shared server is cleaned up properly.

## Title

Playwright API: BrowserContext

## Url

https://playwright.dev/docs/api/class-browsercontext

## Resource Type

API Reference

## Relevance

This page details the core concept of browser contexts in Playwright. It explains that contexts are isolated environments, which is how Playwright achieves test isolation (e.g., separate cookies, storage) even when tests run in parallel using a single browser instance. This directly answers the user's question about the 'one expensive browser, many isolated tests' pattern.

## Title

Playwright: Test Fixtures

## Url

https://playwright.dev/docs/test-fixtures

## Resource Type

Official Documentation

## Relevance

Fixtures are the mechanism Playwright uses to provide resources, like isolated `page` and `context` objects, to tests. Understanding fixtures is key to implementing clean, maintainable tests that leverage Playwright's isolation model.

## Title

Model Context Protocol (MCP) Example Servers

## Url

https://github.com/modelcontextprotocol/servers

## Resource Type

GitHub Repository

## Relevance

This repository contains official example implementations of MCP servers. It serves as a concrete reference for how these servers are built and can be inspected to understand their startup behavior and communication protocols, which is essential for writing effective E2E tests against them.

## Title

MCP Inspector Tool

## Url

https://modelcontextprotocol.io/docs/tools/inspector

## Resource Type

Tool Documentation

## Relevance

This official tool is designed for testing and debugging MCP servers. It demonstrates an interactive way to communicate with an MCP server, which can inform how the automated E2E tests should be structured to interact with the server's stdio.

