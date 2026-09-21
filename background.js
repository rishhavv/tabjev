// MV3 service worker. No top-level state except the debounce map (its loss on
// worker eviction is harmless — a missed debounce just means one extra call).
import {
  DEFAULTS,
  LOG_KEY,
  buildCriteria,
  buildRequest,
  decide,
  describeGroup,
  pickColor,
  pushLog,
} from "./lib.js";

// ponytail: single global debounce map, no per-window partitioning. Ceiling:
// fine for a handful of tabs firing `complete` in quick succession; if this
// ever needs cross-tab coordination (e.g. cancel siblings in the same
// redirect chain), swap for a keyed structure. Upgrade path: none needed
// until MV3 gives workers a real event-scoped state store.
const debounceTimers = new Map();

async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function callJev(settings, body) {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  };

  const start = performance.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    return null;
  }

  if (res.status === 401 || res.status === 403) {
    try {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    } catch {
      // ponytail: badge calls are best-effort UI feedback; if they throw
      // (e.g. no action surface yet) the auth-disable below still runs.
    }
    await chrome.storage.local.set({ enabled: false });
    console.warn(`TabJev: Jev API auth failed (status ${res.status})`);
    return null;
  }

  if (res.status === 429 || res.status === 529) {
    // ponytail: one fixed retry, no exponential backoff queue. Ceiling: fine
    // for occasional rate limiting; a burst of many tabs hitting 429 in a
    // row will just drop most of them. Upgrade path: a shared backoff queue
    // keyed by baseUrl if this becomes a real problem.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let retryRes;
    try {
      retryRes = await fetch(url, init);
    } catch {
      return null;
    }
    if (!retryRes.ok) {
      console.warn(`TabJev: Jev API error after retry (status ${retryRes.status})`);
      return null;
    }
    const ms = performance.now() - start;
    const json = await retryRes.json();
    chrome.action.setBadgeText({ text: "" });
    return { json, ms };
  }

  if (!res.ok) {
    console.warn(`TabJev: Jev API error (status ${res.status})`);
    return null;
  }

  const ms = performance.now() - start;
  const json = await res.json();
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {
    // best-effort
  }
  return { json, ms };
}

async function classifyAndGroup(tabs, windowId) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.apiKey) return;

  const candidates = (tabs ?? []).filter(
    (t) =>
      /^https?:/.test(t.url || "") &&
      !t.pinned &&
      t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
  );
  if (candidates.length === 0) return;

  let shapedGroups = [];
  if (settings.useExisting) {
    const groups = await chrome.tabGroups.query({ windowId });
    shapedGroups = [];
    for (const g of groups) {
      const inGroup = await chrome.tabs.query({ groupId: g.id });
      shapedGroups.push({
        id: g.id,
        title: g.title,
        description: describeGroup(g, inGroup),
      });
    }
  }

  const { criteria, targets } = buildCriteria(
    shapedGroups,
    settings.rules,
    settings.useExisting
  );
  if (Object.keys(criteria).length < 2) return;

  const body = buildRequest({
    tabs: candidates,
    criteria,
    model: settings.model,
    stripQuery: settings.stripQuery,
  });

  const result = await callJev(settings, body);

  // Log every candidate regardless of API outcome, per the log-entry contract.
  const logStore = await chrome.storage.local.get(LOG_KEY);
  let log = logStore[LOG_KEY] ?? [];

  if (!result) {
    const ts = Date.now();
    for (const tab of candidates) {
      log = pushLog(log, {
        ts,
        host: hostOf(tab.url),
        picked: "(none)",
        p: null,
        ms: 0,
        tokens: 0,
      });
    }
    await chrome.storage.local.set({ [LOG_KEY]: log });
    return;
  }

  const { json: response, ms } = result;
  const answers = response.answers ?? {};
  // ponytail: input tokens split evenly across the batch's tabs rather than
  // attributed per-tab (the API does not return per-tab token counts).
  // Ceiling: cost totals in the options page are batch-accurate, not
  // tab-accurate. Upgrade path: none until Jev returns per-question usage.
  const inputTokens = response.usage?.input_tokens ?? 0;
  const tokensPerTab = Math.round(inputTokens / candidates.length);

  const decisions = new Map(); // tabId -> {key, p, title}
  for (const tab of candidates) {
    const answer = answers["t" + tab.id];
    const decision = decide(answer, settings.threshold);
    if (decision) {
      const target = targets[decision.key];
      decisions.set(tab.id, {
        key: decision.key,
        p: decision.p,
        title: target ? target.title : decision.key,
      });
    }
  }

  // Group decided tabs by target key so each target is one grouping call.
  const byKey = new Map();
  for (const [tabId, d] of decisions) {
    if (!byKey.has(d.key)) byKey.set(d.key, []);
    byKey.get(d.key).push(tabId);
  }

  const createdGroups = new Map(); // rule key -> groupId, for this run only
  for (const [key, tabIds] of byKey) {
    const target = targets[key];
    if (!target) continue;
    try {
      if (target.kind === "existing") {
        await chrome.tabs.group({ tabIds, groupId: target.id });
      } else if (target.kind === "rule") {
        let gid = createdGroups.get(key);
        if (gid === undefined) {
          gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
          await chrome.tabGroups.update(gid, {
            title: target.title,
            color: pickColor(target.title),
          });
          createdGroups.set(key, gid);
        } else {
          await chrome.tabs.group({ tabIds, groupId: gid });
        }
      }
    } catch {
      // A tab can close between the API response and the grouping call, and
      // Chrome throws "No tab with id ...". One dead tab must not abort the
      // rest of the batch, so we swallow and continue.
    }
  }

  const ts = Date.now();
  for (const tab of candidates) {
    const d = decisions.get(tab.id);
    log = pushLog(log, {
      ts,
      host: hostOf(tab.url),
      picked: d ? d.title : "(none)",
      p: d ? Math.round(d.p * 100) / 100 : null,
      ms: Math.round(ms),
      tokens: tokensPerTab,
    });
  }
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tab.groupId !== -1 || tab.pinned) return;
  if (!/^https?:/.test(tab.url || "")) return;

  const existing = debounceTimers.get(tabId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    debounceTimers.delete(tabId);
    const settings = await getSettings();
    if (tab.incognito && !settings.allowIncognito) return;
    await classifyAndGroup([tab], tab.windowId);
  }, 800);
  debounceTimers.set(tabId, timer);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const existing = debounceTimers.get(tabId);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(tabId);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  const windowId = tab.windowId;
  const tabs = await chrome.tabs.query({ windowId });
  const ungrouped = tabs.filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
  await classifyAndGroup(ungrouped, windowId);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (!settings.groupOnStartup) return;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const ungrouped = tabs.filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
    await classifyAndGroup(ungrouped, win.id);
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});
