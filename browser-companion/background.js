"use strict";

const GARMIN_HOME = "https://connect.garmin.com/app/home";
const MAXIMUM_RECOVERY_TIMEOUT_MS = 900_000;
const GARMIN_APPLICATION_STABLE_MS = 2_000;
const STATUS_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_REQUEST_TIMEOUT_MS = 15_000;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined || validatedRecoveryUrl(tab.url) === null) return;
  void chrome.tabs.sendMessage(tab.id, { type: "gconnect-browser-recovery-approved" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const recovery = validatedRecoveryMessage(message, sender);
  if (recovery === null) {
    sendResponse({ accepted: false });
    return false;
  }

  void advanceRecovery(recovery).then(sendResponse, () => {
    // A later content-script poll can resume after a transient worker or
    // loopback failure. Do not expose exception text to the localhost page.
    sendResponse({ accepted: true, state: "retry" });
  });
  // Each message owns only one bounded recovery step. The content script sends
  // another message later, so an MV3 worker restart loses no recovery state.
  return true;
});

async function advanceRecovery(recovery) {
  const status = await recoveryStatus(recovery.url);
  if (status.status === "complete") {
    return { accepted: true, state: "complete", expiresAt: status.expiresAt };
  }
  if (status.status === "failed") {
    return { accepted: true, state: "failed", expiresAt: status.expiresAt };
  }
  if (status.status === "verifying") {
    return { accepted: true, state: "waiting", expiresAt: status.expiresAt };
  }

  const tab = await recoveryTab(recovery.tabId);
  if (tab.id === undefined) throw new Error("Garmin tab has no id");
  const applicationUrl = tab.status === "complete" && isGarminApplicationUrl(tab.url)
    ? tab.url
    : undefined;

  if (!hasStableApplication(recovery, applicationUrl)) {
    return {
      accepted: true,
      state: "waiting",
      expiresAt: status.expiresAt,
      tabId: tab.id,
      ...(applicationUrl === undefined ? {} : { applicationUrl })
    };
  }

  assertRecoveryActive(status.expiresAt);
  const cookies = await chrome.cookies.getAll({ url: GARMIN_HOME });
  if (cookies.length === 0) throw new Error("Garmin application has no applicable cookies");
  assertRecoveryActive(status.expiresAt);

  const transfer = {
    protocolVersion: 2,
    nonce: recovery.nonce,
    source: "browser-companion",
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite ?? "unspecified",
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate })
    }))
  };

  const responseStatus = await postSession(recovery.url, transfer);
  if (responseStatus === 202 || responseStatus === 409) {
    return { accepted: true, state: "waiting", expiresAt: status.expiresAt };
  }
  return { accepted: true, state: "failed", expiresAt: status.expiresAt };
}

async function recoveryStatus(recoveryUrl) {
  return withRequestTimeout(STATUS_REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${recoveryUrl}/status`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    });
    if (!response.ok) throw new Error("Recovery status is unavailable");
    const status = await response.json();
    if (status === null || typeof status !== "object") {
      throw new Error("Recovery status is invalid");
    }
    if (!["waiting", "verifying", "complete", "failed"].includes(status.status)) {
      throw new Error("Recovery status is invalid");
    }
    const expiresAt = status.expiresAt;
    const remainingMs = expiresAt - Date.now();
    if (!Number.isSafeInteger(expiresAt) || remainingMs <= 0 || remainingMs > MAXIMUM_RECOVERY_TIMEOUT_MS) {
      throw new Error("Recovery deadline is invalid");
    }
    return { status: status.status, expiresAt };
  });
}

async function postSession(recoveryUrl, transfer) {
  return withRequestTimeout(SESSION_REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${recoveryUrl}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8"
      },
      body: JSON.stringify(transfer),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    });
    await response.body?.cancel();
    return response.status;
  });
}

async function recoveryTab(tabId) {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.id === tabId) return tab;
    } catch {
      // The user may have closed the previous Garmin tab. Open another below.
    }
  }
  return openGarminHome();
}

async function openGarminHome() {
  const existing = await chrome.tabs.query({ url: "https://connect.garmin.com/*" });
  const candidate = existing.find((tab) => Number.isInteger(tab.id));
  if (candidate?.id !== undefined) {
    if (Number.isInteger(candidate.windowId)) {
      await chrome.windows.update(candidate.windowId, { focused: true });
    }
    const updated = await chrome.tabs.update(candidate.id, { url: GARMIN_HOME, active: true });
    if (updated.id === undefined) throw new Error("Garmin tab has no id");
    return updated;
  }

  const created = await chrome.tabs.create({ url: GARMIN_HOME, active: true });
  if (created.id === undefined) throw new Error("Garmin tab has no id");
  return created;
}

function hasStableApplication(recovery, applicationUrl) {
  if (applicationUrl === undefined || recovery.applicationUrl !== applicationUrl) return false;
  if (!Number.isSafeInteger(recovery.applicationReadySince)) return false;
  const elapsed = Date.now() - recovery.applicationReadySince;
  return elapsed >= GARMIN_APPLICATION_STABLE_MS && elapsed <= MAXIMUM_RECOVERY_TIMEOUT_MS;
}

function assertRecoveryActive(expiresAt) {
  if (Date.now() >= expiresAt) throw new Error("Recovery deadline elapsed");
}

function validatedRecoveryMessage(message, sender) {
  if (message === null || typeof message !== "object" || message.type !== "gconnect-browser-recovery") return null;
  if (typeof message.recoveryUrl !== "string" || sender.url !== message.recoveryUrl) return null;
  if (message.tabId !== undefined && (!Number.isSafeInteger(message.tabId) || message.tabId < 0)) return null;
  const hasApplicationUrl = message.applicationUrl !== undefined;
  const hasApplicationReadySince = message.applicationReadySince !== undefined;
  if (hasApplicationUrl !== hasApplicationReadySince) return null;
  if (hasApplicationUrl && typeof message.applicationUrl !== "string") return null;
  if (hasApplicationReadySince && !Number.isSafeInteger(message.applicationReadySince)) return null;
  try {
    const parsed = validatedRecoveryUrl(message.recoveryUrl);
    if (parsed === null) return null;
    return {
      url: parsed.url,
      nonce: parsed.nonce,
      ...(message.tabId === undefined ? {} : { tabId: message.tabId }),
      ...(hasApplicationUrl
        ? {
            applicationUrl: message.applicationUrl,
            applicationReadySince: message.applicationReadySince
          }
        : {})
    };
  } catch {
    return null;
  }
}

function validatedRecoveryUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port.length === 0) return null;
    if (url.search.length > 0 || url.hash.length > 0) return null;
    const match = /^\/recover\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const nonce = match?.[1];
    if (nonce === undefined) return null;
    return { url: url.href.replace(/\/$/, ""), nonce };
  } catch {
    return null;
  }
}

function isGarminApplicationUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://connect.garmin.com"
      && (url.pathname === "/app" || url.pathname.startsWith("/app/"));
  } catch {
    return false;
  }
}

async function withRequestTimeout(milliseconds, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
