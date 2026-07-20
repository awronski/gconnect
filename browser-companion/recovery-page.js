"use strict";

const RECOVERY_POLL_MS = 500;
const MAXIMUM_RECOVERY_TIMEOUT_MS = 900_000;

const recoveryUrl = recoveryPageUrl(window.location.href);
let recoveryStarted = false;
chrome.runtime.onMessage.addListener((message) => {
  const recoveryExpiresAt = recoveryPageDeadline(document);
  if (
    recoveryUrl !== null
    && recoveryExpiresAt !== undefined
    && !recoveryStarted
    && message?.type === "gconnect-browser-recovery-approved"
  ) {
    recoveryStarted = true;
    showRecoveryStatus("Browser recovery approved. Opening Garmin Connect...");
    void pollRecovery(recoveryUrl, recoveryExpiresAt);
  }
});

async function pollRecovery(url, initialExpiresAt) {
  let expiresAt = initialExpiresAt;
  let tabId;
  let applicationUrl;
  let applicationReadySince;

  while (Date.now() < expiresAt) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "gconnect-browser-recovery",
        recoveryUrl: url,
        ...(tabId === undefined ? {} : { tabId }),
        ...(applicationUrl === undefined
          ? {}
          : { applicationUrl, applicationReadySince })
      });
    } catch {
      response = { accepted: true, state: "retry" };
    }

    if (response?.accepted !== true) {
      showRecoveryError("Browser recovery failed. Return to the terminal and try again.");
      return;
    }
    if (response.state === "complete") {
      showRecoveryStatus("Browser session sent. Return to the terminal.");
      return;
    }
    if (response.state === "failed") {
      showRecoveryError("Browser recovery failed. Return to the terminal and try again.");
      return;
    }

    const responseDeadline = validDeadline(response.expiresAt);
    if (responseDeadline !== undefined) expiresAt = Math.min(expiresAt, responseDeadline);

    if (response.state === "waiting") {
      if (Number.isSafeInteger(response.tabId) && response.tabId >= 0) tabId = response.tabId;
      if (typeof response.applicationUrl === "string") {
        if (response.applicationUrl !== applicationUrl) {
          applicationUrl = response.applicationUrl;
          applicationReadySince = Date.now();
        }
      } else {
        applicationUrl = undefined;
        applicationReadySince = undefined;
      }
    } else if (response.state !== "retry") {
      showRecoveryError("Browser recovery failed. Return to the terminal and try again.");
      return;
    }

    await delay(RECOVERY_POLL_MS);
  }

  showRecoveryError("Browser recovery timed out. Return to the terminal and try again.");
}

function validDeadline(value) {
  const remainingMs = value - Date.now();
  return Number.isSafeInteger(value) && remainingMs > 0 && remainingMs <= MAXIMUM_RECOVERY_TIMEOUT_MS
    ? value
    : undefined;
}

function recoveryPageDeadline(page) {
  const value = page.querySelector('meta[name="gconnect-recovery-expires-at"]')?.content;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  return validDeadline(Number(value));
}

function showRecoveryStatus(message) {
  renderRecoveryStatus(message);
}

function showRecoveryError(message) {
  renderRecoveryStatus(message);
}

function renderRecoveryStatus(message) {
  const render = () => {
    const status = document.getElementById("gconnect-recovery-status");
    if (status !== null) status.textContent = message;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
}

function recoveryPageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port.length === 0) return null;
    if (url.search.length > 0 || url.hash.length > 0) return null;
    if (!/^\/recover\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
