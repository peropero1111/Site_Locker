const STORAGE_KEY = "blockedSites";
const ALARM_PREFIX = "unblock:";
let pendingBlockOperation = Promise.resolve();

// Keep overlapping requests from overwriting saved blocks.
function runBlockOperation(operation) {
  const result = pendingBlockOperation.then(operation);
  pendingBlockOperation = result.catch(() => undefined);
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  return runBlockOperation(reconcileBlocks);
});

chrome.runtime.onStartup.addListener(() => {
  return runBlockOperation(reconcileBlocks);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ADD_BLOCK") {
    runBlockOperation(() => addBlock(message.url, message.minutes))
      .then((block) => sendResponse({ ok: true, block }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_BLOCKS") {
    getBlocks()
      .then((blocks) => sendResponse({ ok: true, blocks: getActiveBlocks(blocks) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REMOVE_BLOCK") {
    runBlockOperation(() => removeBlock(message.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) {
    return;
  }

  const id = Number(alarm.name.slice(ALARM_PREFIX.length));
  return runBlockOperation(async () => {
    const block = (await getBlocks()).find((item) => item.id === id);
    if (block && block.expiresAt > Date.now()) {
      await chrome.alarms.create(alarm.name, { when: block.expiresAt });
      return;
    }
    await removeBlock(id);
  });
});

async function addBlock(rawUrl, rawMinutes) {
  const url = parseHttpsUrl(rawUrl);
  const minutes = Number(rawMinutes);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("차단 시간은 1분 이상이어야 합니다.");
  }

  const hostname = normalizeHostname(url.hostname);
  const blocks = await getBlocks();
  const existingSameHost = blocks.filter((item) => item.hostname === hostname);
  if (getActiveBlocks(existingSameHost).length > 0) {
    throw new Error("이 사이트는 이미 차단 중입니다. 차단 시간이 끝난 뒤 다시 설정할 수 있습니다.");
  }

  const now = Date.now();
  const durationMs = Math.ceil(minutes * 60 * 1000);
  const expiresAt = now + durationMs;
  const id = await createRuleId();
  const block = {
    id,
    url: url.href,
    hostname,
    createdAt: now,
    expiresAt
  };

  if (existingSameHost.length > 0) {
    await removeBlocks(existingSameHost.map((item) => item.id));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [],
    addRules: [createRedirectRule(block)]
  });

  const nextBlocks = [...blocks.filter((item) => item.hostname !== hostname), block];
  await saveBlocks(nextBlocks);
  await chrome.alarms.create(`${ALARM_PREFIX}${id}`, { when: expiresAt });
  await updateBadge();
  await refreshMatchingTabs(hostname);

  return block;
}

async function removeBlock(id) {
  await removeBlocks([Number(id)]);
}

async function removeBlocks(ids) {
  const normalizedIds = ids.map(Number).filter((id) => Number.isInteger(id));
  if (normalizedIds.length === 0) {
    return;
  }

  const blocks = await getBlocks();
  const requestedBlocks = blocks.filter((block) => normalizedIds.includes(block.id));
  if (getActiveBlocks(requestedBlocks).length > 0) {
    throw new Error("차단 시간이 끝나기 전에는 해제할 수 없습니다.");
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: normalizedIds,
    addRules: []
  });

  for (const id of normalizedIds) {
    await chrome.alarms.clear(`${ALARM_PREFIX}${id}`);
  }

  await saveBlocks(blocks.filter((block) => !normalizedIds.includes(block.id)));
  await updateBadge();
}

async function reconcileBlocks() {
  const blocks = await getBlocks();
  const activeBlocks = getActiveBlocks(blocks);
  const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();

  // Replace persisted rules so updates also apply to existing blocks.
  if (dynamicRules.length > 0 || activeBlocks.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: dynamicRules.map((rule) => rule.id),
      addRules: activeBlocks.map(createRedirectRule)
    });
  }

  await saveBlocks(activeBlocks);

  for (const block of activeBlocks) {
    await chrome.alarms.create(`${ALARM_PREFIX}${block.id}`, { when: block.expiresAt });
  }

  await updateBadge(activeBlocks.length);
}

async function refreshMatchingTabs(hostname) {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => {
    if (!tab.url) {
      return false;
    }

    try {
      const tabUrl = new URL(tab.url);
      return normalizeHostname(tabUrl.hostname) === hostname;
    } catch {
      return false;
    }
  });

  await Promise.all(
    matchingTabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => undefined))
  );
}

async function updateBadge(count) {
  const activeCount = count ?? getActiveBlocks(await getBlocks()).length;
  await chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

function createRedirectRule(block) {
  return {
    id: block.id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath: "/blocked.html"
      }
    },
    condition: {
      regexFilter: buildHostRegex(block.hostname),
      resourceTypes: ["main_frame"]
    }
  };
}

function buildHostRegex(hostname) {
  const escapedHost = hostname.split(".").map(escapeRegex).join("\\.");
  return `^https?://(www\\.)?${escapedHost}\\.?([/:?#]|$)`;
}

function parseHttpsUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error("https://로 시작하는 올바른 주소를 입력해 주세요.");
  }

  if (url.protocol !== "https:") {
    throw new Error("주소는 https://로 시작해야 합니다.");
  }

  if (!url.hostname) {
    throw new Error("주소에 사이트 도메인이 포함되어야 합니다.");
  }

  return url;
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createRuleId() {
  const blocks = await getBlocks();
  const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const usedIds = new Set(blocks.map((block) => block.id));
  for (const rule of dynamicRules) {
    usedIds.add(rule.id);
  }
  let id = Math.floor(Date.now() % 1000000000);

  while (usedIds.has(id) || id <= 0) {
    id += 1;
  }

  return id;
}

async function getBlocks() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function saveBlocks(blocks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: blocks });
}

function getActiveBlocks(blocks) {
  const now = Date.now();
  return blocks.filter((block) => block.expiresAt > now);
}
