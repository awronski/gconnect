# GConnect Browser Companion

This unpacked Chrome extension is the narrow fallback for `gconnect auth recover`. It is needed because a localhost redirect cannot receive Garmin's domain-scoped, `HttpOnly` authentication cookies.

## Install once

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the absolute `browser-companion` directory printed by `gconnect auth recover`.
5. Keep the extension enabled while using browser-assisted recovery.

After updating GConnect, click **Reload** for the unpacked extension before the next recovery. Companion version 0.2 uses transfer protocol v2 and must run with the matching CLI.

Chrome will show that the extension can access `connect.garmin.com` and `127.0.0.1`. Those are its only host permissions.

## Recover a CLI session

1. Run `gconnect auth recover` in a terminal.
2. Copy the printed `http://127.0.0.1:<port>/recover/<nonce>` link into Chrome.
3. With the recovery page active, click the **GConnect Browser Companion** extension action in Chrome to approve this one-time transfer. Opening the page alone does not release cookies.
4. The companion opens or focuses `https://connect.garmin.com/app/home`.
5. Complete Garmin password, MFA, or CAPTCHA steps only on Garmin's page.
6. While you sign in, the localhost recovery page sends short progress polls to the companion. Each poll is independent, so Chrome may stop and restart the extension service worker without losing the recovery flow.
7. After the Garmin application has remained fully loaded at a stable application URL briefly, the companion sends the applicable cookie snapshot directly to the one-time CLI listener. The listener acknowledges receipt immediately and reports verification progress through later status polls.
8. Return to the terminal. The CLI independently verifies the session before replacing its saved credentials.

If the terminal times out or is cancelled, rerun the command and use the new link. Old links and nonces cannot be reused.

## Security boundary

- The extension queries Chrome's cookie API for the exact URL `https://connect.garmin.com/app/home`.
- It does not read Garmin page content, activities, health data, history, passwords, or unrelated cookies.
- Cookie capture requires a user click on the extension action while the exact IPv4-loopback recovery page is active. A remote page, iframe, or automatic localhost navigation cannot approve a transfer.
- Cookie bytes are posted by the extension background worker directly to loopback. They are never inserted into the localhost page DOM or written to a browser console.
- The localhost page retains only the Garmin tab id, stable application URL, and readiness timestamp between bounded worker polls. It never receives cookie bytes.
- The transfer preserves Chrome's `hostOnly` attribute; the CLI rejects cookies it cannot reproduce instead of silently dropping `__Host-*` authentication cookies.
- The CLI validates the nonce, transfer schema, cookie domains and paths, request size, and one-shot state, then independently verifies the provisional session.
- The loopback page contains no cookie, CSRF token, profile identifier, password, MFA code, or health data.

The companion cannot cryptographically prove that a process listening on loopback is the packaged CLI. Treat other processes running as your local user as trusted, and only approve the exact one-time link printed by the CLI. A malicious local process could serve a lookalike loopback page and ask you to approve it; the explicit extension-action click prevents silent transfer but not deliberate local phishing.

This is a local development-style installation. Remove the extension from `chrome://extensions` when it is no longer needed.
