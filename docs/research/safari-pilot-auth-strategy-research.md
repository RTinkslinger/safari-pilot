# Executive Summary

The investigation into Safari automation strategies for the 'Safari Pilot' framework reveals that a successful approach must work within the constraints of Apple's robust security model, which prioritizes user consent and isolates sensitive interactions from programmatic control. The primary challenge is Safari's strict distinction between trusted user gestures and synthetic events; synthetic JavaScript clicks or focus events will not trigger native password/passkey autofill UI, unlike in some other browsers. This security boundary extends to system-level UI sheets for Passkeys and Sign in with Apple, which are not scriptable via AppleScript or Accessibility APIs, making direct automation of these flows impossible.

Furthermore, programmatic access to the macOS Keychain is tightly controlled. While the Swift Security framework provides the necessary APIs, accessing protected credentials consistently triggers user authentication prompts (e.g., Touch ID), and there is no reliable, documented 'grace period' that would allow a background daemon to bypass these prompts for subsequent reads. The opportunity for the Safari Pilot framework lies in a hybrid architecture that combines multiple technologies for different purposes. Key strategies include: using a Safari Web Extension to reliably detect authentication completion by monitoring for specific network requests (e.g., token exchanges) and URL changes, a method proven effective by frameworks like Playwright; employing AppleScript for high-level browser control, such as enumerating and monitoring OAuth popup windows to capture redirect URLs; and utilizing a Swift LaunchAgent with the UserNotifications framework to communicate with the user. This approach circumvents the challenges of direct UI scripting by instead observing the side effects of authentication, such as navigation and network traffic, to confirm success.

# Key Recommendations For Safari Pilot

## Recommendation

Do not rely on synthetic JavaScript events (e.g., `element.click()`) to trigger password or passkey autofill UI. Instead, use OS-level input synthesis or guide the user to perform the action.

## Related Topic

Safari Autofill Behavior with Synthetic Events

## Justification

Safari's security model requires a 'trusted user gesture' to present sensitive UI like the Passwords app autofill sheet. Synthetic events are not trusted and will fail to trigger the UI, making this automation path unreliable.

## Recommendation

Use a multi-signal strategy for detecting authentication completion, prioritizing network request interception via a Web Extension over DOM or URL polling alone.

## Related Topic

Auth Completion Detection Strategies

## Justification

For modern Single-Page Applications (SPAs), the URL may not change post-login. Intercepting the network call to the token exchange endpoint is the most reliable signal of a successful login, a pattern used by robust frameworks like Playwright.

## Recommendation

Manage OAuth popup windows using an AppleScript polling mechanism that enumerates Safari windows and inspects their URLs for the expected callback.

## Related Topic

OAuth Popup Windows in Safari + AppleScript

## Justification

AppleScript can reliably list all open Safari windows and read their document URLs. This allows the framework to detect when an OAuth flow has completed and redirected back to the application, enabling the capture of the authorization code from the URL.

## Recommendation

Design the Keychain access flow to handle per-operation user prompts (Touch ID/password). Do not assume a persistent, prompt-less session for a background daemon.

## Related Topic

macOS Keychain Programmatic Access

## Justification

Accessing protected Keychain items programmatically via the Security framework triggers system-level prompts to ensure user consent. There is no supported entitlement or simple ACL configuration to grant a daemon permanent, silent access.

## Recommendation

Treat the native Passkey and Sign in with Apple UIs as un-scriptable 'black boxes'. Detect completion by observing post-authentication side effects like navigation or network events.

## Related Topic

Passkey/WebAuthn on Safari

## Justification

These UIs are rendered by the operating system, not the browser's DOM, and are inaccessible to AppleScript or Accessibility APIs for security reasons. Attempting to automate them directly will fail.

## Recommendation

Implement user-facing notifications using the `UserNotifications` framework from a per-user Swift LaunchAgent, not a system-wide LaunchDaemon or `osascript`.

## Related Topic

macOS Notification APIs for Swift Daemons

## Justification

The UserNotifications framework is the modern, reliable API for displaying actionable notifications but requires running in a user's graphical session. A LaunchAgent is the correct context for this, whereas `osascript` is a fragile fallback.

## Recommendation

Do not design any logic that depends on a Touch ID 'grace period' to bypass biometric prompts for Keychain access.

## Related Topic

Touch ID Grace Periods

## Justification

Research and Apple's own documentation indicate that any such grace period is unreliable, its duration is not guaranteed, and it explicitly does not apply to authentications for retrieving Keychain items. Each access should be treated as potentially requiring a new prompt.


# Safari Autofill And Synthetic Events Analysis

## Trusted Gesture Requirement

Safari's native password and passkey autofill UI is only triggered in response to a 'trusted user gesture,' which is a real input originating from a physical user action like a click or tap. This user activation is forwarded by WebKit to macOS's platform-level Authentication Services, which then presents the privileged UI. Conversely, synthetic JavaScript events, such as those dispatched via `element.dispatchEvent(new MouseEvent('click'))` or programmatic `element.focus()` calls, are not considered trusted. Safari explicitly blocks these synthetic events from invoking security-sensitive UI like the autofill sheet to prevent scripts from spoofing user interaction and triggering credential prompts without user consent. While synthetic events can change an input field's value or focus state, they will not cause the native Passwords app autofill or passkey selection sheet to appear.

## Safari Vs Chrome Behavior

Both Safari and Chrome/Chromium treat synthetic JavaScript events as untrusted and will not display their native password manager or autofill UI in response to them. The primary difference lies in their implementation of automatic passkey upgrades following a password-based sign-in. In Safari 18 on macOS 15, the passkey upgrade flow is tightly coupled with a password autofill event from the new Passwords app. A site can trigger the passkey creation UI by calling `navigator.credentials.create({mediation:'conditional'})` immediately after a user performs a password autofill. Chrome, on the other hand, implements a stricter timing window, allowing a passkey upgrade to be initiated within approximately 5 minutes of a successful password-based sign-in, regardless of whether it was an autofill or manual entry. Both browsers require a secure context (HTTPS) for these operations.

## Automation Mitigation Strategies

Given that synthetic DOM events cannot trigger Safari's native autofill UI, automation frameworks must employ alternative strategies. The most effective workarounds include: 1) Using OS-level input synthesis through remote debugging protocols like WebDriver's Actions API or the DevTools Input protocol. These methods generate input events at a lower level, which are more likely to be treated as trusted gestures by the browser. 2) Forgoing attempts to interact with the autofill UI altogether and instead focusing on detecting the completion of authentication. This involves monitoring for post-login signals such as URL changes, specific network requests completing successfully (e.g., a token exchange), or the appearance of specific DOM markers on the page. 3) In hybrid automation scenarios, the script can provide visual guidance for a human operator to perform the click or selection that triggers the native UI.


# Macos Keychain Programmatic Access Analysis

## Cli Vs Framework Comparison

Accessing keychain items can be done via the `security find-internet-password` command-line tool or programmatically using the Swift Security framework. The CLI tool is essentially a wrapper around the Security framework and will trigger the same system-level authorization prompts (password or Touch ID) when an item's access control requires it. The primary difference lies in control and integration. The Swift Security framework offers more granular control, allowing an application to manage the authentication context directly using `LAContext` (from the LocalAuthentication framework) via the `kSecUseAuthenticationContext` key. This enables the app to explicitly trigger and handle biometric prompts. In contrast, the CLI tool simply invokes the system dialogs without giving the calling script any control over the process. For applications, especially signed ones, the Security framework is superior as it allows for the use of entitlements like `keychain-access-groups` for securely sharing secrets between a suite of applications, a feature not applicable to the generic CLI tool. The framework provides detailed error codes, whereas the CLI provides simpler success/failure output.

## Persistent Access For Daemons

A LaunchAgent or daemon can achieve persistent keychain access without repeated user prompts, but under strict conditions. This is not achieved through a special entitlement but by modifying the Access Control List (ACL) of the specific keychain item. A user can manually add an application to an item's 'Always Allow' list via the Keychain Access app, or it can be done programmatically using `SecAccess` APIs. For this to work reliably, the application or daemon must be code-signed, as the ACL entry is tied to the binary's signature and path. Any changes to the binary could invalidate the access. A per-user LaunchAgent is better suited for accessing the user's login keychain than a system-wide LaunchDaemon, as the agent runs within the user's graphical session and inherits access to their unlocked keychains. A LaunchDaemon runs as root outside the user session and cannot typically access a user's keychain without triggering prompts to unlock it. Therefore, for a tool like Safari Pilot, a code-signed LaunchAgent added to the ACL of necessary keychain items is the viable path to avoid repeated prompts.

## Impact Of Macos Passwords App

The new Passwords app introduced in macOS 15 (Sequoia) primarily serves as a new, centralized user interface for managing passwords, passkeys, and other credentials stored in the iCloud Keychain. It does not fundamentally alter the underlying programmatic access model. The core technologies remain the Security framework and Keychain Services APIs. Developers continue to use `SecItemCopyMatching` and related functions to query for credentials. While the Passwords app may be the UI that appears for certain system-level authentication requests (like WebAuthn conditional mediation), the low-level rules governing access—such as entitlements, ACLs, code signing requirements, and the necessity for user approval for protected items—remain unchanged. There is no evidence that the Passwords app introduces new entitlements or APIs that would allow a daemon or background process to silently bypass existing user consent requirements for keychain access.


# Passkey And Webauthn On Safari Analysis

## User Verification Requirement

Safari's implementation of WebAuthn on macOS strictly enforces user verification for passkey operations. Each call to `navigator.credentials.get()` to retrieve a passkey assertion requires explicit user interaction, typically through a Touch ID or Face ID prompt. This behavior is consistent with the WebAuthn specification's `userVerification` modes (`required`, `preferred`). Even if a relying party sets `userVerification` to `discouraged`, Safari's platform authenticator (managed by macOS) will still perform user verification as part of the process. Furthermore, even if a user is already authenticated with their Apple ID on the system, the cryptographic act of signing a WebAuthn challenge still necessitates a fresh, per-interaction biometric verification to confirm user presence and consent, although a very short, undocumented grace period might occasionally bypass an immediate subsequent prompt.

## Conditional Mediation Behavior

Safari 18 on macOS 15 supports WebAuthn's conditional mediation, which can be invoked by calling `navigator.credentials.get()` with `mediation: 'conditional'` and an empty or omitted `allowCredentials` array. This feature allows for the discovery of resident credentials (passkeys) stored in the user's iCloud Keychain without displaying a disruptive modal dialog. Instead, if available passkeys are found for the site, Safari will present them as suggestions within the standard AutoFill UI, attached to the relevant username field. The feature's availability can be checked using `PublicKeyCredential.isConditionalMediationAvailable()`. This flow is designed to streamline login by making passkeys discoverable in the same way as saved passwords, but the final selection still requires user interaction with the system-provided UI.

## Passkey Sheet Automation Constraints

The passkey selection interface in Safari is not part of the web page's DOM. It is a native, system-level UI sheet rendered by macOS's AuthenticationServices framework. This design choice is a critical security measure that isolates the credential selection process from the web page's context, preventing any possibility of spoofing, manipulation, or automation via page JavaScript. Consequently, this system sheet cannot be controlled or interacted with using standard web automation tools, AppleScript, or general-purpose Accessibility APIs. Automation frameworks can trigger the process that shows the sheet by calling the WebAuthn API, but they cannot script the interactions within the sheet itself (e.g., selecting a specific passkey or confirming the choice).


# Oauth Popup Window Automation Analysis

## Applescript Control Capabilities

AppleScript can reliably enumerate all Safari windows, including those opened as OAuth popups via `window.open()`, using commands like `every window of application "Safari"`. Once a window is identified, AppleScript can retrieve its properties, most importantly the URL of its document via `URL of document of window`. This allows an automation script to poll the popup's URL to wait for the authentication flow to complete and redirect to a callback URL containing the authorization code. Furthermore, AppleScript can execute JavaScript within the context of a specific tab or window, although this is subject to the same-origin policy. For OAuth, this means the script can only interact with the popup's content after it has redirected back to a domain controlled by the primary application.

## Popup Blocker Interaction

Safari's popup blocker significantly impacts the reliability of opening OAuth windows. It blocks `window.open()` calls that are not initiated by a direct, trusted user gesture. A feature flag, "verify window.open user gesture", enforces this. This means that popups opened synchronously from a script triggered by a real user click will generally be allowed, while those initiated programmatically without a preceding user action (e.g., on page load or with a delay) will be blocked, prompting the user with a 'Block/Allow' dialog. Automation frameworks must therefore ensure that the action triggering the OAuth popup is synthesized in a way that Safari treats as a genuine user gesture or orchestrate a real click.

## Oauth Provider Flow Patterns

Major OAuth providers like Google, GitHub, and Microsoft offer varied but automatable flows. Google and Microsoft explicitly support both redirect and popup modes. GitHub primarily uses a redirect flow, but applications often wrap it in a popup window. Sign in with Apple also provides a JavaScript library that can utilize a popup. The common pattern across these providers when using a popup is that the window eventually redirects to a developer-controlled URI on the same origin as the opening application. This redirect allows the parent window or an external script (like one using AppleScript) to securely detect the authorization code or token in the URL and complete the login process before closing the popup.


# Sign In With Apple Automation Analysis

## Ui Presentation

The 'Sign in with Apple' interface on macOS can be presented in multiple ways depending on the implementation. If a website uses the native ASAuthorization APIs, Safari will display a native system sheet that can include 'Sign in with Apple' alongside passkey and password options. Alternatively, if the site uses a pure web-based OAuth flow, it may be presented as a web page, which itself might be rendered inside a system sheet or a separate popup window. This distinction is critical, as a standard web page is more amenable to automation than a native system UI component.

## Automation Feasibility

Automating the 'Sign in with Apple' flow is challenging. If it is presented as a web page within a system sheet, it cannot be directly controlled via AppleScript's browser-specific commands. However, it may be possible to interact with it using macOS's Accessibility APIs, which can manipulate generic UI elements. If the flow uses a native system sheet (e.g., via ASAuthorization or for passkey selection), it is generally not scriptable by either AppleScript or Accessibility APIs. This is a deliberate security measure to prevent programmatic hijacking of the authentication process.

## Authenticated Session Behavior

Even if a user is already authenticated with their Apple ID on the system, the 'Sign in with Apple' flow does not guarantee a completely automated or prompt-free experience. Depending on the security policy, the flow may either auto-fill the details or still require user verification, typically via a Touch ID or password prompt. This is because the action often involves cryptographic operations that mandate explicit user consent for each transaction, although a very short grace period after a recent authentication might occasionally bypass an immediate subsequent prompt.


# Authentication Completion Detection Strategies

## Reliable Detection Signals

Several signals can be used to reliably detect authentication completion, with varying strengths. The most robust signals are: 1) **URL Changes**: Waiting for the browser's top-level URL to match a specific pattern (e.g., `/dashboard`) is highly reliable for traditional redirect-based flows. This is often done with `page.waitForURL` or `page.waitForNavigation`. 2) **Network Requests**: Intercepting network traffic and waiting for a specific API response (e.g., a POST to `/api/token` that returns a 200 OK status) is extremely reliable for both traditional apps and SPAs. This is a core feature in Playwright (`page.waitForResponse`). 3) **DOM Markers**: Waiting for a specific element that only appears post-login (e.g., a 'Logout' button or a user avatar element) is a solid strategy, especially for SPAs. 4) **Cookie/Storage Mutations**: Polling for the existence of a session cookie or a token in `localStorage`/`sessionStorage` can work but is more prone to race conditions if the write operation is not immediate.

## Spa Vs Traditional App Patterns

The best detection strategy differs significantly between Single-Page Applications (SPAs) and traditional multi-page apps. For **traditional apps**, the most decisive signal is a navigation event leading to a change in the final URL. The flow typically involves one or more HTTP 3xx redirects culminating in a landing page like `/account` or `/dashboard`. Automation can simply wait for this final URL. For **SPAs**, the URL may not change after login, or it may change via the History API without a full page load. Therefore, the most robust signal is often a **network response**. The automation script should wait for the specific XHR/fetch request that exchanges credentials for an authentication token. As a fallback, polling `localStorage` or `sessionStorage` for the token or waiting for a key DOM element to be rendered by the client-side router are effective secondary strategies.

## Framework Best Practices

Leading automation frameworks like Playwright, Puppeteer, and Selenium have established best practices for reliably waiting for authentication. A critical pattern is to initiate the wait *before* triggering the action that causes the state change. For example, `await Promise.all([ page.waitForNavigation(), page.click('button[type=submit]') ]);` ensures that the script doesn't miss a fast redirect. Playwright's documentation explicitly discourages the use of `networkidle` waits, as they are often flaky and can hang indefinitely due to background polling or analytics scripts. Instead, it recommends using explicit, targeted waits like `page.waitForResponse()` for a specific API endpoint or `page.waitForURL()` for a known post-login URL. For SPAs, it's also recommended to block service workers during testing to ensure that network request interception works reliably.


# Macos Notifications From Daemons Analysis

## Usernotifications Framework Usage

To send native notifications from a background process, the UserNotifications framework is the recommended method. The process must run as a per-user LaunchAgent, not a system-wide LaunchDaemon, because it needs to operate within the user's graphical session to access their notification center. The implementation involves several steps: 1) Import the `UserNotifications` framework. 2) Get the shared `UNUserNotificationCenter.current()` instance. 3) Request user permission via `center.requestAuthorization(options:)`, which will prompt the user on the first run. 4) Define notification categories (`UNNotificationCategory`) and associated actions (`UNNotificationAction` or `UNTextInputNotificationAction`) to create interactive notifications with buttons. 5) Register these categories using `center.setNotificationCategories(_:)`. 6) To handle responses, a delegate conforming to `UNUserNotificationCenterDelegate` must be set to process callbacks like `userNotificationCenter(_:didReceive:withCompletionHandler:)`. 7) Finally, a notification is created by building a `UNMutableNotificationContent` and scheduling a `UNNotificationRequest`. Sandboxed helpers must declare the `com.apple.security.notifications` entitlement.

## Osascript Fallback Method

Using `osascript -e 'display notification "..."'` is a possible fallback for sending simple, non-actionable notifications. However, its use is highly constrained and considered unreliable for critical alerts. It only works reliably when the script is executed from a process running within an active user's graphical session and has the necessary scripting or accessibility permissions. It will fail or be ignored when run from a system-level LaunchDaemon, in a headless context, or at the login window, as these contexts lack the required user session infrastructure. Therefore, it should not be the primary mechanism for a robust notification system.

## Architectural Recommendation

The recommended architecture for a system-level service that needs to display user notifications is a two-part design using Inter-Process Communication (IPC). A system-wide LaunchDaemon, running as root, should handle the core background tasks. When a notification needs to be displayed, this daemon should not attempt to post it directly. Instead, it should communicate the notification request to a lightweight, per-user LaunchAgent helper process via a secure IPC mechanism like XPC. The LaunchAgent, running within the logged-in user's session, has the necessary context to access the `UNUserNotificationCenter` and can then use the UserNotifications framework to properly present the notification, including any action buttons, on behalf of the system daemon. This separation of concerns ensures that each component operates within the correct security and session context, providing a reliable and supported solution.


# Touch Id Grace Period Analysis

## Grace Period Existence And Scope

A universal, system-wide Touch ID grace period that allows bypassing all subsequent biometric prompts for a set duration does not exist for keychain item retrieval. Apple's LocalAuthentication documentation explicitly states that the grace period associated with unlocking a device with Touch ID does not apply to authentications for keychain access. Instead, keychain locking behavior is configurable on a per-keychain basis using the `security set-keychain-settings` command, which allows setting an inactivity timeout. This is distinct from a biometric reuse window. While some anecdotal evidence suggests a very short (few seconds) caching of authorization within a single process's `LAContext`, it is not a documented, guaranteed, or configurable system-wide feature. The scope of any such behavior is limited and should not be relied upon for automation.

## Applicability To Keychain Access

A recent Touch ID authentication for one purpose (e.g., unlocking the Mac) does not grant a grace period for programmatic keychain reads. Access to a specific keychain item is governed by that item's own Access Control flags (e.g., `kSecAttrAccessControl` with `kSecAccessControlBiometryAny`). If an item is protected and requires user presence or biometrics, both the `security` CLI and the Swift Security framework (`SecItemCopyMatching`) will trigger a new, distinct authentication prompt every time the item is accessed, unless the calling application is explicitly on the item's 'Always Allow' ACL. The concept of reusing a recent biometric success does not apply to bypassing these per-item security requirements.

## Apple Watch Unlock Interaction

The Apple Watch 'Auto Unlock' feature is designed to unlock a Mac when the user is nearby, bypassing the need to enter a password at the login screen. It can also be used to approve some system-level prompts that would otherwise require a password. However, it does not serve as a substitute for Touch ID or Face ID when accessing keychain items that are specifically protected by biometrics. Community reports and developer experiences confirm that the watch cannot be used to approve prompts for reading protected keychain data, such as passwords or passkeys stored in iCloud Keychain. For automation purposes, Apple Watch unlock should be considered a convenience for session login, not a mechanism to bypass security prompts for sensitive data access.


# Technical Mitigations And Workarounds

## Challenge

Synthetic event rejection

## Mitigation Strategy

Instead of dispatching JavaScript DOM events (e.g., `focus()`, `click()`), which Safari does not trust for sensitive actions, use automation protocols that synthesize input at a lower level to be treated as a trusted user gesture.

## Implementation Notes

This can be achieved using WebDriver's Actions API or by leveraging remote debugging protocols (like the Chrome DevTools Protocol, if a similar interface exists for Safari) that provide commands like `Input.dispatchMouseEvent`.

## Challenge

Un-scriptable UI for Passkeys and Sign in with Apple

## Mitigation Strategy

Do not attempt to interact with the system sheet directly. Instead, monitor for the results of a successful authentication. The most reliable signal is a specific network request being made (e.g., to an API endpoint that exchanges a code for a session token) or a navigation to a post-login URL.

## Implementation Notes

Use a Safari Web Extension with the `browser.webRequest` API to listen for `onCompleted` events on specific URLs. Coordinate this with AppleScript, which can monitor for changes in the browser's top-level URL.

## Challenge

Detecting login completion in Single-Page Applications (SPAs)

## Mitigation Strategy

Since SPAs may not perform a full-page navigation after login, rely on intercepting network requests. Wait for the specific API call that finalizes authentication (e.g., a POST to `/api/token`) and returns a success status. As a fallback, poll `localStorage` or `sessionStorage` for the presence of an auth token.

## Implementation Notes

Implement this logic within a Safari Web Extension. To ensure reliability, configure the automation to block service workers, as they can intercept requests and prevent the `webRequest` listener from firing.

## Challenge

Handling OAuth popup windows

## Mitigation Strategy

Use AppleScript to periodically enumerate all open Safari windows. In a loop, check the URL of each window's document to see if it matches the expected OAuth callback URI. Once the match is found, extract the authorization code from the URL string.

## Implementation Notes

The AppleScript should look like: `tell application "Safari" to set winList to every window`. Loop through `winList`, get `URL of document of w`, and parse it. This script should be run with a timeout after the action that triggers the popup.

## Challenge

Persistent Touch ID prompts for Keychain access

## Mitigation Strategy

Embrace the security model by designing the flow to handle prompts gracefully. When accessing a protected item, use the `LocalAuthentication` framework's `LAContext` to programmatically trigger the system's biometric/password prompt and await its result.

## Implementation Notes

In the Swift daemon, before calling `SecItemCopyMatching`, create an `LAContext` and pass it in the query dictionary with the `kSecUseAuthenticationContext` key. This gives you control over the prompt's localized reason string.


# Security And Privacy Considerations

The security model for the proposed 'Safari Pilot' automation framework is fundamentally shaped by Apple's security-first design principles, which prioritize explicit user consent and action for sensitive operations. A key principle is the distinction between trusted user gestures and synthetic events; Safari will not display privileged UI like password autofill or passkey sheets in response to programmatic JavaScript events, a measure to prevent malicious scripts from tricking users. Similarly, the passkey selection UI is a system-level sheet, making it immune to automation via AppleScript or Accessibility APIs, which prevents spoofing or automated credential selection. Granting the framework permissions for Automation and Accessibility is a significant security consideration, as it gives the tool broad control over the user's system. The most critical risk involves programmatic keychain access. While a daemon can be granted persistent access to a keychain item via its ACL, this permanently widens the attack surface for that secret. It's crucial to note that there is no entitlement to bypass user approval for arbitrary keychain reads; access is granted on a per-item, per-application basis only after explicit user action. Therefore, the framework must be designed to work with, not against, these protections. It must handle system prompts gracefully, rely on OS-level event synthesis to be treated as a trusted actor, and operate on the principle of least privilege, requesting access only to the specific keychain items it needs.

# Impact Of Macos 15 Sequoia And Safari 18

The upcoming macOS 15 Sequoia and Safari 18 introduce significant changes that directly impact web authentication strategies. The most notable changes are the introduction of a dedicated Passwords app and enhanced support for WebAuthn in Safari.

1.  **New Passwords App**: macOS 15 Sequoia centralizes credential management into a new 'Passwords' application. While this provides a new user interface for managing passwords, passkeys, and other credentials, the research indicates that the underlying programmatic access model via the Security framework and Keychain Services APIs remains largely unchanged. Daemons and applications will still be subject to the same access control lists (ACLs), user prompts (like Touch ID), and entitlement requirements as before.

2.  **WebAuthn Conditional Mediation in Safari 18**: Safari 18 adds support for `mediation='conditional'` in the WebAuthn API. This is a major enhancement for user experience, as it allows websites to automatically offer a passkey upgrade immediately after a user successfully signs in using a traditional password. The flow, as described in WebKit's documentation, ties this feature to the password autofill event from the new Passwords app. When a user autofills a password, the browser can then invoke `navigator.credentials.create()` with conditional mediation to seamlessly create a passkey for that account in the background, reducing friction for passkey adoption.

3.  **System-Level UI and Automation Constraints**: The passkey selection and creation UIs are implemented as system-level sheets managed by AuthenticationServices, not as part of the web page's DOM. This is a security measure to prevent spoofing or automation by page scripts. Consequently, these native sheets cannot be controlled via JavaScript, AppleScript, or standard Accessibility APIs, posing a challenge for automation frameworks which must rely on detecting the outcome (e.g., navigation, network requests) rather than interacting with the prompt itself.

In summary, for an automation framework like Safari Pilot, the updates mean that while direct Keychain access remains consistent, the web-facing authentication landscape is evolving. The new conditional mediation flow in Safari 18 presents an opportunity for more seamless passkey creation but also reinforces the barrier against programmatically interacting with native authentication prompts.

# Applescript Vs Accessibility Apis Comparison

## Applescript Strengths

AppleScript's primary strength for Safari automation lies in its direct, high-level control over the browser's application model. It can robustly enumerate all windows and tabs, get and set their URLs, and execute arbitrary JavaScript within the context of a web page. This makes it ideal for navigating, polling for state changes based on URLs, and interacting with the DOM of web pages, including those in OAuth popup windows (subject to same-origin policy). It is the best tool for managing the web content layer of the browser.

## Accessibility Api Strengths

The Accessibility APIs operate at the UI element level, independent of the application. Their strength is the ability to interact with system-level UI elements that are outside the control of AppleScript's application-specific dictionary. This includes native macOS dialogs, permission prompts, and system sheets, such as the one used for 'Sign in with Apple'. When a browser presents a native UI element instead of a web-based one, Accessibility APIs are the only potential method for programmatic interaction, allowing scripts to identify and trigger actions on buttons, text fields, and other controls.

## Recommended Usage

For a comprehensive automation framework like Safari Pilot, a hybrid approach is essential. AppleScript should be used for all browser-level and web page interactions: navigating to URLs, managing windows and tabs, and executing JavaScript to control web content. Accessibility APIs should be reserved for the specific, necessary cases where the automation must interact with native macOS UI elements presented by Safari or the system, such as permission dialogs or the 'Sign in with Apple' sheet, which are opaque to AppleScript. This combination leverages the strengths of each technology to cover both the web content and the native application chrome.

