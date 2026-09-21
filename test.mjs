import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  DEFAULT_RULES,
  LOG_MAX,
  GROUP_COLORS,
  parseRules,
  slug,
  sanitizeUrl,
  describeGroup,
  buildCriteria,
  buildRequest,
  decide,
  pickColor,
  pushLog,
  estimateCost,
  PRICE_PER_MTOK,
} from "./lib.js";

// ---------- parseRules ----------

test("parseRules: blank lines and comments are skipped, order preserved", () => {
  const text = [
    "Work | Work stuff",
    "",
    "# a comment",
    "  Shopping  |  Buying things  ",
    "News",
    "Docs | has | extra | pipes",
    "|",
    "   ",
  ].join("\n");
  const result = parseRules(text);
  assert.deepEqual(result, [
    { name: "Work", description: "Work stuff" },
    { name: "Shopping", description: "Buying things" },
    { name: "News", description: "" },
    { name: "Docs", description: "has | extra | pipes" },
  ]);
});

test("parseRules: a line that is only '|' is dropped (empty name)", () => {
  const result = parseRules("|\nA | B");
  assert.deepEqual(result, [{ name: "A", description: "B" }]);
});

// ---------- sanitizeUrl ----------

test("sanitizeUrl: strips query and hash when stripQuery is true", () => {
  assert.equal(
    sanitizeUrl("https://example.com/path?x=1#frag", true),
    "https://example.com/path"
  );
});

test("sanitizeUrl: passes through unchanged when stripQuery is false", () => {
  const url = "https://example.com/path?x=1#frag";
  assert.equal(sanitizeUrl(url, false), url);
});

test("sanitizeUrl: returns input unchanged for a non-URL string", () => {
  assert.equal(sanitizeUrl("not a url", true), "not a url");
});

// ---------- buildCriteria ----------

test("buildCriteria: none is the first key", () => {
  const { criteria } = buildCriteria(
    [{ id: 1, title: "Work", description: "" }],
    "News | headlines",
    true
  );
  assert.equal(Object.keys(criteria)[0], "none");
  assert.equal(criteria.none, "Does not clearly belong to any listed group");
});

test("buildCriteria: useExisting false omits existing groups", () => {
  const { criteria, targets } = buildCriteria(
    [{ id: 1, title: "Work", description: "Work stuff" }],
    "News | headlines",
    false
  );
  assert.equal(Object.keys(criteria).includes("work"), false);
  assert.equal(Object.keys(targets).includes("work"), false);
  assert.deepEqual(Object.keys(criteria), ["none", "news"]);
});

test("buildCriteria: a rule colliding with an existing group slug is dropped", () => {
  const { criteria, targets } = buildCriteria(
    [{ id: 1, title: "Work", description: "Work stuff" }],
    "Work | duplicate rule",
    true
  );
  assert.deepEqual(Object.keys(criteria), ["none", "work"]);
  assert.equal(criteria.work, "Work stuff");
  assert.equal(targets.work.kind, "existing");
});

test("buildCriteria: two rules with the same slug get _2 suffix", () => {
  const { criteria, targets } = buildCriteria(
    [],
    "Work | first\nWork | second",
    true
  );
  assert.deepEqual(Object.keys(criteria), ["none", "work", "work_2"]);
  assert.equal(criteria.work, "first");
  assert.equal(criteria.work_2, "second");
  assert.equal(targets.work.kind, "rule");
  assert.equal(targets.work_2.kind, "rule");
});

test("buildCriteria: the 254 cap truncates the tail", () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`rule${i} | desc${i}`);
  const { criteria, targets } = buildCriteria([], lines.join("\n"), true);
  assert.equal(Object.keys(criteria).length, 255); // none + 254
  assert.equal(Object.keys(targets).length, 254);
  assert.equal("rule0" in criteria, true);
  assert.equal("rule253" in criteria, true);
  assert.equal("rule254" in criteria, false);
});

test("buildCriteria: the shipped DEFAULTS.rules alone give a usable criteria set", () => {
  // C1 regression: a fresh install has zero tab groups. If DEFAULTS.rules is
  // empty the only criterion is `none`, buildRequest refuses the body and the
  // extension is a permanent silent no-op.
  const { criteria, targets } = buildCriteria([], DEFAULTS.rules, true);
  assert.equal(Object.keys(criteria).length > 1, true);
  assert.deepEqual(Object.keys(criteria), [
    "none", "work", "dev", "social", "video", "shopping", "reading",
  ]);
  assert.equal(Object.keys(targets).length, 6);
  assert.equal(DEFAULTS.rules, DEFAULT_RULES);
});

test("buildCriteria: targets never contains none", () => {
  const { targets } = buildCriteria(
    [{ id: 1, title: "Work", description: "" }],
    "News | headlines",
    true
  );
  assert.equal("none" in targets, false);
});

test("buildCriteria: empty description falls back to title", () => {
  const { criteria } = buildCriteria(
    [{ id: 1, title: "Work", description: "" }],
    "News",
    true
  );
  assert.equal(criteria.work, "Work");
  assert.equal(criteria.news, "News");
});

// ---------- describeGroup ----------

test("describeGroup: exact separator string for 2 tabs", () => {
  const result = describeGroup(
    { title: "Work", color: "blue" },
    [
      { url: "https://a.com/page", title: "A page" },
      { url: "https://b.com/page", title: "B page" },
    ]
  );
  assert.equal(
    result,
    "Work. Examples: a.com – A page; b.com – B page"
  );
});

test("describeGroup: 3-tab cap ignores a 4th tab", () => {
  const result = describeGroup(
    { title: "Work" },
    [
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
      { url: "https://c.com", title: "C" },
      { url: "https://d.com", title: "D" },
    ]
  );
  assert.equal(
    result,
    "Work. Examples: a.com – A; b.com – B; c.com – C"
  );
});

test("describeGroup: a 61-char title is trimmed with an ellipsis", () => {
  const longTitle = "x".repeat(61);
  const result = describeGroup(
    { title: "Work" },
    [{ url: "https://a.com", title: longTitle }]
  );
  const expectedTitle = "x".repeat(60) + "…";
  assert.equal(result, `Work. Examples: a.com – ${expectedTitle}`);
});

test("describeGroup: empty tab list returns just the title", () => {
  const result = describeGroup({ title: "Work" }, []);
  assert.equal(result, "Work.");
});

test("describeGroup: undefined group title becomes Untitled group", () => {
  const result = describeGroup({}, []);
  assert.equal(result, "Untitled group.");
});

// ---------- decide ----------

test("decide: below threshold returns null", () => {
  const answer = { type: "choice", choice: "work", probabilities: { none: 0.3, work: 0.4 } };
  assert.equal(decide(answer, 0.55), null);
});

test("decide: choice 'none' returns null", () => {
  const answer = { type: "choice", choice: "none", probabilities: { none: 0.9, work: 0.1 } };
  assert.equal(decide(answer, 0.55), null);
});

test("decide: missing probabilities falls back to confidence", () => {
  const answer = { type: "choice", choice: "work", confidence: 0.8 };
  assert.deepEqual(decide(answer, 0.55), { key: "work", p: 0.8 });
});

test("decide: a clear winner returns {key, p}", () => {
  const answer = { type: "choice", choice: "work", probabilities: { none: 0.02, work: 0.91 } };
  assert.deepEqual(decide(answer, 0.55), { key: "work", p: 0.91 });
});

test("decide: probabilities without an entry for the choice fails closed", () => {
  // I3 regression: p is undefined here, and `undefined < threshold` is false,
  // so the old comparison grouped the tab in spite of the threshold.
  const answer = { type: "choice", choice: "dev", probabilities: { other: 0.9 } };
  assert.equal(decide(answer, 0.55), null);
});

test("decide: falsy answer returns null", () => {
  assert.equal(decide(null, 0.55), null);
  assert.equal(decide(undefined, 0.55), null);
});

// ---------- pickColor ----------

test("pickColor: same input gives the same output twice", () => {
  assert.equal(pickColor("Work"), pickColor("Work"));
});

test("pickColor: a non-empty name never returns grey", () => {
  const names = ["Work", "News", "Shopping", "a", "zzzzzz", "The Quick Brown Fox"];
  for (const name of names) {
    assert.notEqual(pickColor(name), "grey");
  }
});

test("pickColor: output is always a member of GROUP_COLORS", () => {
  for (const name of ["Work", "News", "", "Something Else"]) {
    assert.equal(GROUP_COLORS.includes(pickColor(name)), true);
  }
});

test("pickColor: empty string returns grey", () => {
  assert.equal(pickColor(""), "grey");
});

// ---------- pushLog ----------

test("pushLog: does not mutate its input", () => {
  const buffer = [1, 2, 3];
  const copy = [...buffer];
  pushLog(buffer, 4);
  assert.deepEqual(buffer, copy);
});

test("pushLog: trims from the front at LOG_MAX + 1 entries", () => {
  const buffer = Array.from({ length: LOG_MAX }, (_, i) => i);
  const result = pushLog(buffer, "new");
  assert.equal(result.length, LOG_MAX);
  assert.equal(result[0], 1);
  assert.equal(result[result.length - 1], "new");
});

test("pushLog: treats a non-array buffer as []", () => {
  const result = pushLog(null, "first");
  assert.deepEqual(result, ["first"]);
});

// ---------- buildRequest ----------

test("buildRequest: wire-shape fixture for 2 tabs", () => {
  const tabs = [
    { id: 1, url: "https://a.com/page?x=1", title: "A page" },
    { id: 2, url: "https://b.com/page", title: "B page" },
  ];
  const { criteria } = buildCriteria(
    [{ id: 10, title: "Work", description: "" }],
    "News | headlines",
    true
  );
  const body = buildRequest({ tabs, criteria, model: "jev-latest", stripQuery: true });

  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.length, 2);
  assert.equal(body.state[0].url, "https://a.com/page");

  const keys = Object.keys(body.questions);
  assert.equal(keys.length, 2);
  for (const key of keys) {
    assert.match(key, /^t\d+$/);
    assert.equal(body.questions[key].type, "choice");
    assert.equal(body.questions[key].criteria, criteria);
  }
});

test("buildRequest: throws TypeError on empty tab list", () => {
  const { criteria } = buildCriteria([{ id: 1, title: "Work", description: "" }], "", true);
  assert.throws(
    () => buildRequest({ tabs: [], criteria, model: "jev-latest", stripQuery: true }),
    TypeError
  );
});

test("buildRequest: throws TypeError when criteria holds only none", () => {
  const tabs = [{ id: 1, url: "https://a.com", title: "A" }];
  assert.throws(
    () =>
      buildRequest({
        tabs,
        criteria: { none: "Does not clearly belong to any listed group" },
        model: "jev-latest",
        stripQuery: true,
      }),
    TypeError
  );
});

// ---------- misc / constants sanity ----------

test("DEFAULTS is frozen and has the expected shape", () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.equal(DEFAULTS.threshold, 0.55);
  assert.equal(DEFAULTS.baseUrl, "https://api.typesafe.ai");
});

test("estimateCost computes price per million input tokens", () => {
  assert.equal(estimateCost(1_000_000), PRICE_PER_MTOK);
  assert.equal(estimateCost(500_000), PRICE_PER_MTOK / 2);
  assert.equal(estimateCost(0), 0);
});
