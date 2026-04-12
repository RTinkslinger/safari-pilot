# P3: HTTP Authentication — Research Report

Research for Safari Pilot's HTTP authentication handling, covering Safari's native behavior, Playwright's implementation, and viable automation strategies.

---

## 1. Safari's HTTP Auth Dialog

### What It Looks Like

Safari presents HTTP authentication challenges (Basic, Digest, NTLM, Negotiate) as a **native macOS sheet dialog** attached to the browser window. This is not a web page element or part of the DOM — it is a system-level modal rendered by Safari's UI layer (AppKit/NSAlert-style sheet).

The dialog contains:
- A text field for username
- A secure text field for password
- A "Remember this password" checkbox
- Cancel and Log In buttons
- A message showing the realm and server hostname

### Dialog Behavior

- **Per-tab**: The dialog is attached to the tab/window that triggered the authentication challenge.
- **Modal**: It blocks interaction with the page content behind it while visible.
- **JavaScript blocking**: The auth dialog almost certainly blocks JavaScript execution on the main thread of the page that triggered the 401. The dialog is modal at the system UI level, freezing the rendering process until the user acts. There is no official Apple documentation confirming this, but it follows from the fact that the networking layer pauses the resource load pending credential resolution.
- **Cross-origin suppression**: Safari may silently suppress auth dialogs for cross-origin subresource requests (images, scripts loaded from a different domain) as an anti-phishing measure. Instead of prompting, it fails the request with 401.

### AppleScript Interaction

AppleScript can interact with the dialog via System Events GUI scripting:

```applescript
tell application "System Events"
    tell process "Safari"
        -- Wait for the auth sheet to appear
        repeat until exists sheet 1 of window 1
            delay 0.1
        end repeat
        -- Fill username
        set value of text field 1 of sheet 1 of window 1 to "myuser"
        -- Fill password
        set value of text field 2 of sheet 1 of window 1 to "mypass"
        -- Click Log In
        click button "Log In" of sheet 1 of window 1
    end tell
end tell
```

**Caveats:**
- Requires Accessibility permissions (System Preferences > Privacy > Accessibility)
- Fragile — field order and button labels can change across Safari versions
- The sheet may take a moment to appear; need polling
- Text field indices (1 vs 2) may vary; one is the username, the other the password

### Accessibility API (AXUIElement)

The `AXUIElement` API can also interact with the dialog programmatically. Since the dialog is a standard AppKit sheet, it exposes accessibility attributes:

- `AXSheet` child of the window
- `AXTextField` elements for username and password
- `AXButton` elements for Cancel and Log In

The Swift daemon could use `AXUIElementCopyAttributeValue` to find the sheet, then `AXUIElementSetAttributeValue` to fill fields and `AXUIElementPerformAction` with `kAXPressAction` to click buttons. This is more reliable than AppleScript keystroke injection but still UI-dependent and breakable.

**Sources:**
- https://developer.apple.com/documentation/applicationservices/axuielement_h
- https://stackoverflow.com/questions/46944109/entering-login-info-with-applescript
- https://www.macscripter.net/t/automate-safari-logins-using-dialog-boxes/61780

---

## 2. Playwright's Authentication Implementation

### How `httpCredentials` Works

Playwright provides HTTP authentication via `browser.newContext({ httpCredentials: { username, password } })`. The mechanism:

1. **First request is sent without credentials** — Playwright lets the request go through normally.
2. **Server responds with 401 Unauthorized** and a `WWW-Authenticate` header.
3. **Playwright intercepts the 401** at the protocol level and **re-issues the request** with the appropriate `Authorization` header (e.g., `Authorization: Basic base64(user:pass)`).
4. **The native auth dialog is suppressed** — because the protocol layer handles the challenge before it reaches Safari's UI.

This is confirmed by the Playwright community: "If you use `httpCredentials`, Playwright will make a request omitting the `Authorization` header. It then expects a 401 status code in the response and, if it gets that, will repeat the request with the credentials." (Source: Stack Overflow)

### Internal Architecture for WebKit

Playwright's WebKit support uses a **patched WebKit binary** with a custom **Web Inspector Protocol** layer (not standard CDP, but CDP-compatible). The Playwright team contributes patches directly to WebKit that add protocol commands for:

- **Network interception**: Can intercept requests and responses at the protocol level
- **Navigation control**: Cross-process navigation handling
- **JavaScript execution**: Run scripts in execution contexts

The authentication is handled through this network interception layer — the inspector protocol intercepts the 401 response and the Playwright server re-issues the request with credentials.

Key source files:
- `packages/playwright-core/src/server/webkit/` — WebKit connection layer
- `packages/playwright-core/src/server/webkit/protocol.d.ts` — ~9,783 lines of WebKit Inspector Protocol type definitions

### Alternative: `extraHTTPHeaders`

Playwright also supports pre-emptive auth by setting headers directly:

```typescript
await page.setExtraHTTPHeaders({
    Authorization: 'Basic ' + btoa('admin:admin')
});
```

This sends the `Authorization` header on every request without waiting for a 401 challenge. This is simpler but sends credentials even to resources that don't require them.

### What Playwright Supports

| Auth Type | Supported | Mechanism |
|-----------|-----------|-----------|
| Basic | Yes | Re-issue with `Authorization: Basic` header |
| Digest | Yes (via route) | Can construct Digest auth header via route handler |
| NTLM | Limited | Not natively supported; requires manual header construction |
| Negotiate/Kerberos | No | Depends on OS ticket system; Playwright can't access Kerberos TGT |

### Origin Scoping

The `httpCredentials` option accepts an `origin` field. If no origin is specified, credentials are sent to any server upon 401 response. If an origin is specified (e.g., `https://example.com`), credentials are only sent for requests to that origin.

**Sources:**
- https://playwright.dev/docs/network#http-authentication
- https://playwright.dev/docs/api/class-browsertype (httpCredentials documentation)
- https://docs.webkit.org/Other/Contributor%20Meetings/Slides2023/Playwright%20and%20the%20State%20of%20Modern%20E2E%20Testing.pdf
- https://stackoverflow.com/questions/73069593/playwright-basic-authentication-for-api-test
- https://testdino.com/blog/playwright-architecture/
- https://leeroopedia.com/index.php/Implementation:Microsoft_Playwright_WebKit_Protocol_Types

---

## 3. HTTP Auth via Header Injection

### declarativeNetRequest (Safari Web Extension)

Safari Pilot already has the `declarativeNetRequest` permission in its manifest and has working DNR infrastructure (`dnr_add_rule` / `dnr_remove_rule` in background.js). This is the most promising approach.

**Since Safari 16.4**, the `declarativeNetRequest` API supports `modifyHeaders` actions. A rule can inject an `Authorization` header into matching requests:

```json
{
    "id": 1,
    "priority": 1,
    "action": {
        "type": "modifyHeaders",
        "requestHeaders": [
            {
                "header": "Authorization",
                "operation": "set",
                "value": "Basic dXNlcjpwYXNz"
            }
        ]
    },
    "condition": {
        "urlFilter": "example.com",
        "resourceTypes": ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "image", "other"]
    }
}
```

**Key requirements:**
- The manifest must declare `declarativeNetRequestWithHostAccess` permission (Safari Pilot already has `declarativeNetRequest` but may need the host-access variant for header modification)
- Per-site permissions must be granted by the user
- Safari **will skip showing the auth dialog** if the request already includes a valid `Authorization` header — the dialog only appears when the server returns 401 and no credentials were sent

**Important restrictions on "standard" vs "custom" headers:**

Safari Web Extensions using `declarativeNetRequest` can modify **standard** HTTP headers (Authorization, Cookie, User-Agent, etc.). For truly custom headers, the approach differs:
- Web Extension (`declarativeNetRequest`): Can modify standard headers including Authorization. Source: WWDC23 session 10119.
- Safari App Extension (`additionalRequestHeaders`): Can add custom headers, but Safari namespaces them with `X-Safari-Extension-...` prefix. Requires `SFSafariWebsiteAccess` Info.plist configuration and macOS 14+.

For our use case (injecting `Authorization`), the Web Extension approach with `declarativeNetRequest` is correct and sufficient.

**Sources:**
- https://developer.apple.com/la/videos/play/wwdc2023/10119/?time=378
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
- https://github.com/adobe/helix-sidekick-extension/issues/720
- https://medium.com/@christian.carroll.1703/adding-custom-request-headers-with-a-safari-extension-5019874569c3

### Security Implications

- Basic auth credentials are Base64-encoded (not encrypted). Over HTTPS this is acceptable; over HTTP, credentials are exposed in transit.
- The DNR rule containing the Base64 credentials exists only in the extension's dynamic rule set (in-memory/extension storage), not persisted to disk in a user-readable location.
- Credentials should be scoped to specific URL patterns to avoid leaking them to unintended servers.
- Rules should be cleaned up (removed) when authentication is no longer needed.

---

## 4. NTLM and Kerberos on macOS

### NTLM Support

Safari supports NTLM authentication for both web servers and proxy servers. NTLM is a challenge-response protocol:

1. Client sends initial request (no auth)
2. Server responds 401 with `WWW-Authenticate: NTLM`
3. Client sends Type 1 (Negotiate) message
4. Server responds with Type 2 (Challenge) message
5. Client computes and sends Type 3 (Authenticate) message

This multi-step handshake is handled by Safari's underlying `CFNetwork` framework. The native auth dialog appears once to collect credentials, and CFNetwork handles the NTLM handshake internally.

**Automation challenge:** NTLM cannot be handled by simple header injection on the first request. The challenge-response requires multiple round-trips. However, if credentials are pre-populated in macOS Keychain, CFNetwork can handle the handshake transparently.

### Kerberos/Negotiate

macOS has **built-in Kerberos support**. The Kerberos SSO extension (com.apple.AppSSOAgent) handles HTTP Negotiate authentication:

- **MDM-deployed**: The Kerberos SSO extension is configured via an MDM profile (Extensible SSO configuration payload). Once deployed, Safari automatically uses Kerberos tickets for matching URLs.
- **Manual setup**: Users can use `kinit` to obtain a TGT, and `klist` to view tickets. Safari will use these tickets for Negotiate challenges.
- **Proactive TGT acquisition**: On macOS, the Kerberos SSO extension proactively acquires TGTs on network state changes.
- **Ticket Viewer**: `/System/Library/CoreServices/Applications/Ticket Viewer.app` shows current tickets.

For automation, the `app-sso` command-line tool allows scripts to:
- Read the state of the Kerberos SSO extension
- Request sign-in
- Trigger common actions

```bash
# Check Kerberos ticket status
klist
# Obtain a new ticket
kinit user@REALM.COM
# Use app-sso to interact with SSO extension
app-sso -l  # list
```

### Enterprise Integration

Corporate environments typically configure Safari authentication via:
1. **Kerberos SSO extension** deployed through MDM (Jamf, Mosyle, etc.)
2. **Configuration profiles** that specify allowed URLs and authentication behavior
3. **Active Directory** integration (devices don't need to be AD-joined; local accounts work)

The SSO extension handles `HTTP 401 Negotiate` challenges automatically — no dialog appears for pre-authenticated users.

**Sources:**
- https://support.apple.com/guide/deployment/kerberos-sso-extension-depe6a1cda64/web
- https://apple.stackexchange.com/questions/118150/safari-7-cant-connect-to-intranet-using-http-authentication

---

## 5. Credential Caching

### Where Safari Stores HTTP Auth Credentials

When the user checks "Remember this password" in the HTTP auth dialog:

- Credentials are stored in the **macOS Keychain** as an "Internet password" entry (Kind: `Internet password`, as opposed to `Web form password` for regular form logins).
- If iCloud Keychain is enabled, credentials sync across devices.
- Without "Remember this password", credentials are cached **in-memory** for the session only. Closing and reopening Safari clears them.

### Cache Scope

- **Per-realm**: HTTP auth credentials are scoped to the authentication realm (the `realm` parameter in the `WWW-Authenticate` header) and the server.
- **Per-session when not saved**: If not saved to Keychain, credentials last until Safari is quit.
- **Known issue**: Safari has been reported to prompt repeatedly for Basic auth credentials even within a session, particularly for subresource requests. Cross-origin subresources may not inherit the parent page's cached credentials.

### Pre-populating the Keychain

The `security` command-line tool can add Internet passwords to the Keychain that Safari will use:

```bash
security add-internet-password \
    -a "username" \
    -l "example.com (username)" \
    -s "example.com" \
    -w "password" \
    -r "htps" \
    -t "mrof" \
    -T "/Applications/Safari.app" \
    -T "/usr/bin/security"
```

**Critical detail**: The `-t "mrof"` parameter (authenticationType, reversed "form") is essential. Without it, Safari creates a duplicate entry in the Keychain on first use. With `-t "mrof"`, Safari uses the existing entry directly.

Other parameters:
- `-a`: account (username)
- `-s`: server hostname
- `-w`: password
- `-r`: protocol (`htps` for HTTPS, `http` for HTTP)
- `-T`: trusted application that can access this entry without prompting

**This is a viable automation strategy**: Pre-populate the Keychain before navigating to the auth-protected URL, and Safari will use the stored credentials automatically (if the "always allow" ACL is set via `-T`). No dialog will appear.

### NSURLCredentialStorage

`NSURLCredentialStorage` is the in-memory credential cache used by `NSURLSession` and `CFNetwork`. It manages credentials for the current process's URL sessions.

- `URLCredentialStorage.shared` is per-process — Safari has its own instance.
- Credentials with `.permanent` persistence are written to Keychain.
- An external process (like the Safari Pilot daemon) **cannot directly access Safari's in-memory `NSURLCredentialStorage`** due to process isolation. However, the Keychain is shared, so writing to Keychain via the `security` CLI is the viable path.

**Sources:**
- https://apple.stackexchange.com/questions/459912/where-does-safari-persist-the-credentials-of-https-basic-authentication
- https://www.macscripter.net/t/adding-internet-passwords-to-keychain-by-invoking-security/69149
- https://developer.apple.com/documentation/foundation/urlcredentialstorage
- https://discussions.apple.com/thread/254628456

---

## 6. Alternative Approaches

### URL-Embedded Credentials (`user:pass@host`)

**Deprecated and unreliable.** Modern Safari strips credentials from URLs or blocks such requests entirely. This is a security measure to prevent credential exposure in browser history, server logs, and referrer headers. Do not use.

### Proxy Authentication

Safari handles proxy auth similarly to web auth — a native dialog appears when a proxy server returns 407. The proxy configuration is at the macOS system level (System Settings > Network > Proxies), not in Safari.

**Automation approach**: An alternative to injecting Authorization headers is running a local proxy (like BrowserMob) that:
1. Receives Safari's requests
2. Adds the Authorization header
3. Forwards to the target server

This works for Selenium-based Safari automation (as documented by Shawn Lobo) but is heavyweight and requires system proxy configuration changes. Not ideal for Safari Pilot.

### Client Certificate Authentication

Safari supports client certificates stored in the macOS Keychain. Automation approach:

1. Import the client certificate into Keychain.
2. Create an **identity preference** associating the certificate with a specific URL:
   ```bash
   security set-identity-preference -s "https://example.com" -Z <cert-hash>
   ```
3. Safari will automatically use the specified certificate for that URL, suppressing the certificate selection dialog.

This is fully automatable via the `security` command-line tool.

### Pre-auth with curl + Cookie Passing

**Not viable.** macOS sandboxing prevents external processes from writing to Safari's cookie store. While `curl` or `NSURLSession` can authenticate and obtain session cookies, transferring those cookies to Safari requires going through the Web Extension's `cookies` API — which Safari Pilot already supports.

A hybrid approach could work:
1. Use `curl`/`NSURLSession` to authenticate and get the session cookie.
2. Use Safari Pilot's `safari_cookie_set` tool (via the extension's `browser.cookies.set`) to inject the cookie into Safari.
3. Navigate to the authenticated resource.

This bypasses HTTP auth entirely by converting it to cookie-based session auth. Only works if the target server issues session cookies after HTTP auth succeeds.

**Sources:**
- https://shawnlobo96.medium.com/bypassing-basic-authentication-on-safari-in-an-automation-test-with-selenium-and-a-proxy-on-a-mac-a89b0bc4ddf
- https://stackoverflow.com/questions/47478164/ios-11-safari-how-to-pass-user-password-in-url-for-http-basic-authentication

---

## 7. Recommended Implementation Strategy for Safari Pilot

### Primary: DNR Header Injection (Extension)

This is the cleanest approach and leverages infrastructure Safari Pilot already has.

**New tool: `safari_authenticate`**

```typescript
// Parameters:
{
    username: string,
    password: string,
    urlPattern?: string,   // default: current tab's origin
    authType?: 'basic',    // future: 'digest'
}
```

**Implementation:**

1. Encode credentials: `btoa(username + ':' + password)`
2. Add a DNR rule via the extension's existing `dnr_add_rule` command:
   ```json
   {
       "id": <generated>,
       "priority": 1,
       "action": {
           "type": "modifyHeaders",
           "requestHeaders": [{
               "header": "Authorization",
               "operation": "set",
               "value": "Basic <base64>"
           }]
       },
       "condition": {
           "urlFilter": "<urlPattern>",
           "resourceTypes": ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "image", "font", "other"]
       }
   }
   ```
3. Navigate to the URL (or re-navigate if already on it).
4. Safari sees the Authorization header, accepts it, and **never shows the auth dialog**.
5. Provide a way to remove the rule when done (via existing `dnr_remove_rule`).

**Advantages:**
- Uses existing Safari Pilot infrastructure (DNR is already wired up)
- No UI interaction needed (no brittle AppleScript)
- Works pre-emptively (no 401 round-trip needed)
- Clean API surface matching Playwright's `httpCredentials`

**Limitations:**
- Only handles Basic auth (Digest/NTLM require multi-step challenge-response)
- Requires `declarativeNetRequestWithHostAccess` permission (check if current `declarativeNetRequest` suffices for header modification, or if manifest needs updating)
- Per-site permission grant needed

### Fallback: Keychain Pre-population (Daemon)

For cases where DNR doesn't work (e.g., NTLM/Digest), the daemon can pre-populate the Keychain:

```bash
security add-internet-password -a "$USERNAME" -s "$HOST" -w "$PASSWORD" -r "htps" -t "mrof" -T "/Applications/Safari.app" -T "/usr/bin/security"
```

This makes Safari use the stored credentials automatically. Add a cleanup command to remove the entry after automation completes:

```bash
security delete-internet-password -a "$USERNAME" -s "$HOST"
```

### Fallback: AppleScript Dialog Interaction

Last resort for scenarios where neither DNR nor Keychain works. The daemon already has AppleScript execution capability. Use polling to detect when the auth sheet appears, then fill and submit:

```applescript
tell application "System Events"
    tell process "Safari"
        if exists sheet 1 of window 1 then
            set value of text field 1 of sheet 1 of window 1 to "user"
            set value of text field 2 of sheet 1 of window 1 to "pass"
            click button "Log In" of sheet 1 of window 1
        end if
    end tell
end tell
```

**This should be the fallback, not the primary approach.** It is inherently fragile and requires Accessibility permissions.

### Implementation Effort Estimate

| Component | Effort |
|-----------|--------|
| `safari_authenticate` tool (DNR-based) | ~2 hours |
| Manifest permission check/update | ~15 min |
| Keychain fallback (daemon side) | ~1 hour |
| AppleScript fallback | ~30 min (mostly already exists) |
| Tests | ~1 hour |
| **Total** | **~half session** (matches roadmap estimate) |

---

## 8. Open Questions

1. **Does Safari's `declarativeNetRequest` allow modifying the `Authorization` header specifically?** Chrome's implementation lists certain "restricted" headers. Testing needed to confirm Safari doesn't restrict `Authorization`.

2. **Permission variant**: Does `declarativeNetRequest` (already in manifest) support `modifyHeaders`, or does the manifest need to switch to `declarativeNetRequestWithHostAccess`? Per WWDC23, `declarativeNetRequestWithHostAccess` is required for `modifyHeaders` and `redirect` actions in Safari 16.4+.

3. **Digest auth feasibility via DNR**: Digest auth requires the server's nonce to compute the response hash. This means we'd need to:
   - Let the first request go through and receive the 401 with nonce
   - Compute the Digest response hash
   - Inject the `Authorization: Digest ...` header on the retry
   This is more complex than Basic but technically possible with a two-step flow.

4. **NTLM via Keychain**: Does pre-populating the Keychain allow CFNetwork to handle the NTLM handshake automatically? Needs testing in an environment with an NTLM-protected server.
