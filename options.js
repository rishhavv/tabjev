import { DEFAULTS, LOG_KEY, PRICE_PER_MTOK, estimateCost, buildRequest } from "./lib.js";

const TYPESAFE_HOST = "api.typesafe.ai";

const el = {
  apiKey: document.getElementById("apiKey"),
  test: document.getElementById("test"),
  testResult: document.getElementById("testResult"),
  baseUrl: document.getElementById("baseUrl"),
  baseUrlHelp: document.getElementById("baseUrlHelp"),
  model: document.getElementById("model"),
  useExisting: document.getElementById("useExisting"),
  rules: document.getElementById("rules"),
  threshold: document.getElementById("threshold"),
  thresholdOut: document.getElementById("thresholdOut"),
  stripQuery: document.getElementById("stripQuery"),
  groupOnStartup: document.getElementById("groupOnStartup"),
  allowIncognito: document.getElementById("allowIncognito"),
  enabled: document.getElementById("enabled"),
  logBody: document.querySelector("#log tbody"),
  logSummary: document.getElementById("logSummary"),
  clearLog: document.getElementById("clearLog"),
  savedIndicator: document.getElementById("savedIndicator"),
};

const BASE_URL_HELP_DEFAULT =
  "Change this to use OpenRouter, the Vercel AI Gateway, or Cloudflare AI Gateway instead of TypeSafe directly.";

let savedFadeTimer = null;

function showSaved() {
  el.savedIndicator.classList.add("show");
  if (savedFadeTimer) clearTimeout(savedFadeTimer);
  savedFadeTimer = setTimeout(() => {
    el.savedIndicator.classList.remove("show");
  }, 1200);
}

function populate(settings) {
  el.apiKey.value = settings.apiKey;
  el.baseUrl.value = settings.baseUrl;
  el.model.value = settings.model;
  el.useExisting.checked = settings.useExisting;
  el.rules.value = settings.rules;
  el.threshold.value = settings.threshold;
  el.thresholdOut.textContent = settings.threshold;
  el.stripQuery.checked = settings.stripQuery;
  el.groupOnStartup.checked = settings.groupOnStartup;
  el.allowIncognito.checked = settings.allowIncognito;
  el.enabled.checked = settings.enabled;
}

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.local.get(DEFAULTS);
  populate(settings);
  await renderLog();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (LOG_KEY in changes) {
    renderLog();
  }
  // The service worker writes `enabled: false` on a 401/403. An options page
  // left open must not keep showing the extension as active.
  if (changes.enabled) {
    el.enabled.checked = changes.enabled.newValue;
  }
});

// Re-enable after the worker disabled us on a 401/403: store the flag, clear
// the badge, tick the box. Used by both the key field and a passing Test key.
async function markEnabled() {
  await chrome.storage.local.set({ enabled: true });
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // best-effort
  }
  el.enabled.checked = true;
}

// --- Simple field saves -----------------------------------------------

el.apiKey.addEventListener("change", async () => {
  const value = el.apiKey.value;
  if (value !== "") {
    await chrome.storage.local.set({ apiKey: value });
    await markEnabled();
  } else {
    await chrome.storage.local.set({ apiKey: value });
  }
  showSaved();
});

el.model.addEventListener("change", async () => {
  await chrome.storage.local.set({ model: el.model.value });
  showSaved();
});

el.useExisting.addEventListener("change", async () => {
  await chrome.storage.local.set({ useExisting: el.useExisting.checked });
  showSaved();
});

el.rules.addEventListener("change", async () => {
  await chrome.storage.local.set({ rules: el.rules.value });
  showSaved();
});

el.threshold.addEventListener("input", () => {
  el.thresholdOut.textContent = el.threshold.value;
});

el.threshold.addEventListener("change", async () => {
  const value = Number(el.threshold.value);
  el.thresholdOut.textContent = String(value);
  await chrome.storage.local.set({ threshold: value });
  showSaved();
});

el.stripQuery.addEventListener("change", async () => {
  await chrome.storage.local.set({ stripQuery: el.stripQuery.checked });
  showSaved();
});

el.groupOnStartup.addEventListener("change", async () => {
  await chrome.storage.local.set({ groupOnStartup: el.groupOnStartup.checked });
  showSaved();
});

el.allowIncognito.addEventListener("change", async () => {
  await chrome.storage.local.set({ allowIncognito: el.allowIncognito.checked });
  showSaved();
});

el.enabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: el.enabled.checked });
  showSaved();
});

// --- Base URL: needs a permission grant when leaving TypeSafe ---------

let lastStoredBaseUrl = DEFAULTS.baseUrl;
chrome.storage.local.get("baseUrl").then((s) => {
  if (typeof s.baseUrl === "string" && s.baseUrl !== "") {
    lastStoredBaseUrl = s.baseUrl;
  }
});

el.baseUrl.addEventListener("change", async () => {
  const value = el.baseUrl.value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    el.baseUrl.value = lastStoredBaseUrl;
    el.baseUrlHelp.textContent = "That is not a valid URL. Reverted to the previous value.";
    return;
  }

  if (parsed.hostname !== TYPESAFE_HOST) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [parsed.origin + "/*"] });
    } catch {
      granted = false;
    }
    if (!granted) {
      el.baseUrl.value = lastStoredBaseUrl;
      el.baseUrlHelp.textContent =
        "Permission to reach that host was declined, so the base URL was not changed.";
      return;
    }
  }

  el.baseUrlHelp.textContent = BASE_URL_HELP_DEFAULT;
  lastStoredBaseUrl = value;
  await chrome.storage.local.set({ baseUrl: value });
  showSaved();
});

// --- Test key -----------------------------------------------------------

const TEST_TAB = {
  id: 1,
  url: "https://github.com/anthropics/claude-code",
  title: "GitHub repository",
};

const TEST_CRITERIA = {
  none: "Does not clearly belong to any listed group",
  dev: "Code, repositories, documentation",
  social: "Social networks and feeds",
};

function setTestResult(text, kind) {
  el.testResult.textContent = text;
  el.testResult.classList.remove("ok", "err");
  if (kind) el.testResult.classList.add(kind);
}

el.test.addEventListener("click", async () => {
  const settings = await chrome.storage.local.get(DEFAULTS);
  const apiKey = el.apiKey.value || settings.apiKey;
  if (!apiKey) {
    setTestResult("Enter a key first.", "err");
    return;
  }

  const body = buildRequest({
    tabs: [TEST_TAB],
    criteria: TEST_CRITERIA,
    model: el.model.value || settings.model,
    stripQuery: settings.stripQuery,
  });

  const url = `${(el.baseUrl.value || settings.baseUrl).replace(/\/+$/, "")}/v1/systemone`;

  setTestResult("Testing…");
  const start = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    setTestResult("Could not reach the endpoint.", "err");
    return;
  }

  const ms = Math.round(performance.now() - start);

  if (res.status === 401 || res.status === 403) {
    // 403 is the likely status for an out-of-credit key, so reporting it as a
    // 401 sends the user off to regenerate a key that was never the problem.
    setTestResult(`Key rejected (${res.status}).`, "err");
    return;
  }
  if (res.status === 429) {
    setTestResult("Rate limited, try again.", "err");
    return;
  }
  if (!res.ok) {
    setTestResult(`Request failed (status ${res.status}).`, "err");
    return;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    setTestResult("Could not parse the response.", "err");
    return;
  }

  const answer = json.answers ? json.answers["t1"] : undefined;
  const picked = answer ? answer.choice : "unknown";
  const inputTokens = json.usage?.input_tokens ?? 0;
  // A passing test proves the key works, so undo any 401/403 auto-disable.
  await markEnabled();
  setTestResult(
    `OK · ${json.model} · ${ms}ms · ${inputTokens} input tokens · picked "${picked}"`,
    "ok"
  );
});

// --- Log table -----------------------------------------------------------

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatConfidence(p) {
  if (p === null || p === undefined) return "—";
  return `${Math.round(p * 100)}%`;
}

function cell(tag, text) {
  const td = document.createElement(tag);
  td.appendChild(document.createTextNode(text));
  return td;
}

async function renderLog() {
  const store = await chrome.storage.local.get(LOG_KEY);
  const log = store[LOG_KEY] ?? [];

  el.logBody.textContent = "";

  if (log.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.appendChild(document.createTextNode("No decisions yet. Open a tab."));
    tr.appendChild(td);
    el.logBody.appendChild(tr);
    el.logSummary.textContent = "";
    return;
  }

  const newestFirst = [...log].reverse();
  for (const entry of newestFirst) {
    const tr = document.createElement("tr");
    tr.appendChild(cell("td", formatTime(entry.ts)));
    tr.appendChild(cell("td", entry.host ?? ""));
    tr.appendChild(cell("td", entry.picked ?? "(none)"));
    tr.appendChild(cell("td", formatConfidence(entry.p)));
    tr.appendChild(cell("td", `${Math.round(entry.ms ?? 0)}ms`));
    el.logBody.appendChild(tr);
  }

  const grouped = log.filter((e) => e.picked && e.picked !== "(none)").length;
  const totalTokens = log.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
  const cost = estimateCost(totalTokens);
  el.logSummary.textContent =
    `${log.length} decisions · ${grouped} tabs grouped · ${totalTokens} input tokens · about $${cost.toFixed(4)}`;
}

el.clearLog.addEventListener("click", async () => {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
});
