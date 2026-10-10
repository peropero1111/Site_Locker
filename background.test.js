const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

function createHarness({ blocks = [], initialRules = [], tabs = [] } = {}) {
  let now = Date.now();
  class Clock extends Date {
    static now() { return now; }
  }
  const storage = { blockedSites: structuredClone(blocks) };
  const rules = new Map(initialRules.map((rule) => [rule.id, structuredClone(rule)]));
  const alarms = new Map();
  const reloadedTabs = [];
  const updates = [];
  const event = () => ({
    listeners: [],
    addListener(listener) { this.listeners.push(listener); }
  });
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    alarms: {
      onAlarm: event(),
      async create(name, options) { alarms.set(name, structuredClone(options)); },
      async clear(name) { return alarms.delete(name); }
    },
    storage: {
      local: {
        async get() { return structuredClone(storage); },
        async set(value) { Object.assign(storage, structuredClone(value)); }
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone([...rules.values()]); },
      async updateDynamicRules(update) {
        const next = new Map(rules);
        for (const id of update.removeRuleIds) next.delete(id);
        for (const rule of update.addRules) {
          assert.equal(next.has(rule.id), false, "Rule IDs must be unique");
          next.set(rule.id, structuredClone(rule));
        }
        rules.clear();
        for (const [id, rule] of next) rules.set(id, rule);
        updates.push(structuredClone(update));
      }
    },
    tabs: {
      async query() { return structuredClone(tabs); },
      async reload(id) { reloadedTabs.push(id); }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };
  const context = vm.createContext({ chrome, URL, Date: Clock });
  vm.runInContext(source, context, { filename: "background.js" });
  return {
    context, storage, rules, alarms, reloadedTabs, updates,
    advanceTime(milliseconds) { now += milliseconds; },
    fireAlarm(name) { return chrome.alarms.onAlarm.listeners[0]({ name }); },
    reloadExtension() { return chrome.runtime.onInstalled.listeners[0]({ reason: "update" }); },
    sendMessage(message) {
      return new Promise((resolve, reject) => {
        const keepAlive = chrome.runtime.onMessage.listeners[0](message, {}, resolve);
        if (keepAlive !== true) reject(new Error("Message was not handled"));
      });
    }
  };
}

function matches(rule, url) {
  return new RegExp(rule.condition.regexFilter, "i").test(url);
}

for (const input of ["https://youtube.com", "https://www.youtube.com"]) {
  test(`${input} blocks YouTube without blocking or reloading Music`, async () => {
    const harness = createHarness({
      tabs: [
        { id: 1, url: "https://youtube.com/" },
        { id: 2, url: "https://www.youtube.com/watch?v=test" },
        { id: 3, url: "https://music.youtube.com/" },
        { id: 4, url: "https://studio.youtube.com/" },
        { id: 5, url: "https://youtube.com.evil.example/" },
        { id: 6, url: "chrome://extensions/" },
        { id: 7 }
      ]
    });
    const block = await harness.context.addBlock(input, 30);
    const rule = harness.rules.get(block.id);
    for (const url of [
      "https://youtube.com/", "https://www.youtube.com/watch?v=test",
      "http://youtube.com/", "https://youtube.com:443/",
      "https://YOUTUBE.COM/", "https://youtube.com./"
    ]) {
      assert.equal(matches(rule, url), true, url);
    }
    for (const url of [
      "https://music.youtube.com/", "https://www.music.youtube.com/",
      "https://studio.youtube.com/", "https://nested.music.youtube.com/",
      "https://youtube.com.evil.example/", "https://notyoutube.com/",
      "https://example.com/youtube.com", "https://youtube.com@music.youtube.com/"
    ]) {
      assert.equal(matches(rule, url), false, url);
    }
    assert.deepEqual(harness.reloadedTabs, [1, 2]);
    assert.equal(rule.action.redirect.extensionPath, "/blocked.html");
    assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
    assert.equal(harness.alarms.get(`unblock:${block.id}`).when, block.expiresAt);
  });
}

test("Music can be blocked separately without blocking YouTube", async () => {
  const harness = createHarness();
  const youtube = await harness.context.addBlock("https://youtube.com", 30);
  const music = await harness.context.addBlock("https://music.youtube.com", 10);
  assert.equal(harness.rules.size, 2);
  const musicRule = harness.rules.get(music.id);
  assert.equal(matches(musicRule, "https://music.youtube.com/"), true);
  assert.equal(matches(musicRule, "https://youtube.com/"), false);
  assert.equal(matches(musicRule, "https://nested.music.youtube.com/"), false);
  harness.advanceTime(10 * 60 * 1000);
  await harness.fireAlarm(`unblock:${music.id}`);
  assert.equal(harness.rules.has(youtube.id), true);
  assert.equal(harness.rules.has(music.id), false);
});

test("saved wildcard rules are updated while expiry times are preserved", async () => {
  const now = Date.now();
  const active = {
    id: 7, hostname: "youtube.com", url: "https://youtube.com/",
    createdAt: now - 60000, expiresAt: now + 1800000
  };
  const expired = { ...active, id: 8, hostname: "example.com", expiresAt: now - 1000 };
  const oldRule = {
    id: 7, priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: {
      regexFilter: "^https?://([^/?#]+\\.)?youtube\\.com([/:?#]|$)",
      resourceTypes: ["main_frame"]
    }
  };
  const harness = createHarness({
    blocks: [active, expired],
    initialRules: [oldRule, { ...oldRule, id: 8 }, { ...oldRule, id: 9 }]
  });
  assert.equal(matches(harness.rules.get(7), "https://music.youtube.com/"), true);
  await harness.reloadExtension();
  assert.equal(matches(harness.rules.get(7), "https://music.youtube.com/"), false);
  assert.equal(matches(harness.rules.get(7), "https://www.youtube.com/"), true);
  assert.deepEqual([...harness.rules.keys()], [7]);
  assert.deepEqual(harness.storage.blockedSites, [active]);
  assert.equal(harness.alarms.get("unblock:7").when, active.expiresAt);
  assert.equal(harness.updates.length, 1);
  await harness.reloadExtension();
  assert.deepEqual(harness.storage.blockedSites, [active]);
});

test("manual removal requests cannot release an active block", async () => {
  const harness = createHarness();
  const block = await harness.context.addBlock("https://youtube.com", 30);
  const snapshot = structuredClone(harness.storage);
  const updateCount = harness.updates.length;
  const response = await harness.sendMessage({ type: "REMOVE_BLOCK", id: block.id });
  assert.equal(response.ok, false);
  assert.equal(typeof response.error, "string");
  await assert.rejects(harness.context.removeBlocks([block.id]), { name: "Error" });
  assert.equal(harness.rules.has(block.id), true);
  assert.deepEqual(harness.storage, snapshot);
  assert.equal(harness.updates.length, updateCount);
  assert.equal(harness.alarms.get(`unblock:${block.id}`).when, block.expiresAt);
});

test("registering the same host again cannot change the active deadline", async () => {
  const harness = createHarness();
  const block = await harness.context.addBlock("https://youtube.com", 30);
  const snapshot = structuredClone(harness.storage);
  for (const [url, minutes] of [
    ["https://youtube.com", 1],
    ["https://www.youtube.com/watch?v=test", 60]
  ]) {
    const response = await harness.sendMessage({ type: "ADD_BLOCK", url, minutes });
    assert.equal(response.ok, false);
    assert.deepEqual(harness.storage, snapshot);
    assert.equal(harness.rules.size, 1);
    assert.equal(harness.alarms.get(`unblock:${block.id}`).when, block.expiresAt);
  }
});

test("an alarm cannot remove a block before its deadline", async () => {
  const harness = createHarness();
  const block = await harness.context.addBlock("https://youtube.com", 1);
  harness.advanceTime(60000 - 1);
  await harness.fireAlarm(`unblock:${block.id}`);
  assert.equal(harness.rules.has(block.id), true);
  assert.equal(harness.storage.blockedSites.length, 1);
  assert.equal(harness.alarms.get(`unblock:${block.id}`).when, block.expiresAt);
  harness.advanceTime(1);
  await harness.fireAlarm(`unblock:${block.id}`);
  assert.equal(harness.rules.has(block.id), false);
  assert.deepEqual(harness.storage.blockedSites, []);
  assert.equal(harness.alarms.has(`unblock:${block.id}`), false);
});

test("expired sites can be registered again even if their alarm was delayed", async () => {
  const harness = createHarness();
  const previous = await harness.context.addBlock("https://youtube.com", 1);
  harness.advanceTime(60000);
  const response = await harness.sendMessage({
    type: "ADD_BLOCK", url: "https://www.youtube.com", minutes: 30
  });
  assert.equal(response.ok, true);
  assert.equal(harness.rules.has(previous.id), false);
  assert.equal(harness.rules.has(response.block.id), true);
  assert.equal(harness.alarms.has(`unblock:${previous.id}`), false);
  assert.equal(response.block.expiresAt, previous.expiresAt + 30 * 60 * 1000);
  assert.deepEqual(harness.storage.blockedSites, [structuredClone(response.block)]);
});

test("overlapping registrations cannot overwrite other active blocks", async () => {
  const harness = createHarness();
  const responses = await Promise.all([
    harness.sendMessage({ type: "ADD_BLOCK", url: "https://youtube.com", minutes: 30 }),
    harness.sendMessage({ type: "ADD_BLOCK", url: "https://music.youtube.com", minutes: 10 })
  ]);
  assert.deepEqual(responses.map((response) => response.ok), [true, true]);
  assert.equal(harness.storage.blockedSites.length, 2);
  assert.equal(harness.rules.size, 2);
  harness.advanceTime(10 * 60 * 1000);
  await harness.fireAlarm(`unblock:${responses[1].block.id}`);
  assert.deepEqual(harness.storage.blockedSites, [structuredClone(responses[0].block)]);
  assert.equal(harness.rules.has(responses[0].block.id), true);
});

test("overlapping same-host requests keep the original duration and recover after rejection", async () => {
  const harness = createHarness();
  const responses = await Promise.all([
    harness.sendMessage({ type: "ADD_BLOCK", url: "https://youtube.com", minutes: 30 }),
    harness.sendMessage({ type: "ADD_BLOCK", url: "https://www.youtube.com", minutes: 1 })
  ]);
  assert.deepEqual(responses.map((response) => response.ok), [true, false]);
  assert.deepEqual(harness.storage.blockedSites, [structuredClone(responses[0].block)]);
  const removal = await harness.sendMessage({ type: "REMOVE_BLOCK", id: responses[0].block.id });
  assert.equal(removal.ok, false);
  const music = await harness.sendMessage({
    type: "ADD_BLOCK", url: "https://music.youtube.com", minutes: 10
  });
  assert.equal(music.ok, true);
  assert.equal(harness.storage.blockedSites.length, 2);
});
