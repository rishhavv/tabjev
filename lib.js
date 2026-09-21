// Pure, chrome-free module. No side effects at import time. No calls into the
// chrome namespace. This is the frozen contract shared by background.js,
// options.js and tests.

// C1: shipped as the default so a zero-configuration install groups the very
// first tab. Without a seeded rule set a new user has no tab groups, so the
// only criterion is `none` and the extension is a permanent silent no-op.
export const DEFAULT_RULES = [
  "Work | jira, google docs, email, calendar, company wiki",
  "Dev | github, stack overflow, api docs, localhost",
  "Social | twitter, reddit, linkedin, instagram",
  "Video | youtube, netflix, twitch",
  "Shopping | amazon, flipkart, product and checkout pages",
  "Reading | news, blogs, newsletters, long articles",
].join("\n");

export const DEFAULTS = Object.freeze({
  apiKey: "",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  useExisting: true,
  rules: DEFAULT_RULES,
  threshold: 0.55,
  stripQuery: true,
  groupOnStartup: false,
  allowIncognito: false,
  enabled: true,
});

export const LOG_KEY = "log";
export const LOG_MAX = 200;

export const GROUP_COLORS = Object.freeze([
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
]);

export const PRICE_PER_MTOK = 0.042;

export function parseRules(text) {
  const rules = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sepIndex = line.indexOf("|");
    let name, description;
    if (sepIndex === -1) {
      name = line.trim();
      description = "";
    } else {
      name = line.slice(0, sepIndex).trim();
      description = line.slice(sepIndex + 1).trim();
    }
    if (name === "") continue;
    rules.push({ name, description });
  }
  return rules;
}

export function slug(name) {
  let s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") s = "g";
  return s.slice(0, 40);
}

export function sanitizeUrl(url, stripQuery) {
  if (!stripQuery) return url;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function truncateTitle(title) {
  const t = String(title ?? "");
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

export function describeGroup(group, tabsInGroup) {
  const title = group?.title ? group.title : "Untitled group";
  const tabs = (tabsInGroup ?? []).slice(0, 3);
  if (tabs.length === 0) return `${title}.`;
  const examples = tabs.map((tab) => {
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch {
      host = tab.url;
    }
    return `${host} – ${truncateTitle(tab.title)}`;
  });
  return `${title}. Examples: ${examples.join("; ")}`;
}

export function buildCriteria(groups, rules, useExisting) {
  const criteria = {};
  const targets = {};
  criteria.none = "Does not clearly belong to any listed group";

  const usedKeys = new Set(["none"]);
  let count = 0;
  const CAP = 254;

  function uniqueKey(baseKey) {
    if (!usedKeys.has(baseKey)) return baseKey;
    let n = 2;
    while (usedKeys.has(`${baseKey}_${n}`)) n++;
    return `${baseKey}_${n}`;
  }

  if (useExisting) {
    for (const group of groups ?? []) {
      if (count >= CAP) break;
      const baseKey = slug(group.title);
      const key = uniqueKey(baseKey);
      const description = group.description || group.title;
      criteria[key] = description;
      targets[key] = { kind: "existing", id: group.id, title: group.title };
      usedKeys.add(key);
      count++;
    }
  }

  const existingSlugs = new Set(
    (useExisting ? groups ?? [] : []).map((g) => slug(g.title))
  );

  for (const rule of parseRules(rules)) {
    if (count >= CAP) break;
    const baseKey = slug(rule.name);
    if (existingSlugs.has(baseKey)) continue;
    const key = uniqueKey(baseKey);
    const description = rule.description || rule.name;
    criteria[key] = description;
    targets[key] = { kind: "rule", id: null, title: rule.name };
    usedKeys.add(key);
    count++;
  }

  return { criteria, targets };
}

export function buildRequest({ tabs, criteria, model, stripQuery }) {
  if (!tabs || tabs.length === 0) {
    throw new TypeError("buildRequest: tabs must be a non-empty array");
  }
  if (!criteria || Object.keys(criteria).length < 2) {
    throw new TypeError("buildRequest: criteria must have at least 2 keys");
  }
  const state = tabs.map((t) => ({
    id: t.id,
    url: sanitizeUrl(t.url, stripQuery),
    title: t.title,
  }));
  const questions = {};
  for (const t of tabs) {
    questions["t" + t.id] = {
      type: "choice",
      instructions:
        "Tab " + t.id + " in the list above: which group does this browser tab belong in? " +
        "Judge by the site and the page title. Answer none when it does not clearly fit.",
      criteria,
    };
  }
  return { model, state, questions };
}

export function decide(answer, threshold) {
  if (!answer) return null;
  if (answer.choice === "none") return null;
  let p;
  if (answer.probabilities) {
    p = answer.probabilities[answer.choice];
  } else if (answer.confidence !== undefined) {
    p = answer.confidence;
  } else {
    p = 1;
  }
  // Fail closed: when `probabilities` exists but carries no entry for the
  // chosen key, `p` is undefined and `undefined < threshold` is false, which
  // would group the tab in spite of the threshold.
  if (!(p >= threshold)) return null;
  return { key: answer.choice, p };
}

export function pickColor(name) {
  const str = String(name ?? "");
  if (str === "") return "grey";
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const palette = GROUP_COLORS.slice(1);
  const index = (hash >>> 0) % palette.length;
  return palette[index];
}

export function pushLog(buffer, entry) {
  const base = Array.isArray(buffer) ? buffer : [];
  const next = [...base, entry];
  return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
}

export function estimateCost(totalInputTokens) {
  return (totalInputTokens / 1e6) * PRICE_PER_MTOK;
}
