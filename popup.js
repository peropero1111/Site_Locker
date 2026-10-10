const form = document.querySelector("#blockForm");
const siteUrlInput = document.querySelector("#siteUrl");
const minutesInput = document.querySelector("#minutes");
const statusEl = document.querySelector("#status");
const blockList = document.querySelector("#blockList");
const refreshButton = document.querySelector("#refresh");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("차단을 설정하는 중입니다...");

  const response = await sendMessage({
    type: "ADD_BLOCK",
    url: siteUrlInput.value,
    minutes: minutesInput.value
  });

  if (!response.ok) {
    setStatus(response.error || "차단 설정에 실패했습니다.", true);
    return;
  }

  siteUrlInput.value = "";
  setStatus(`${response.block.hostname} 차단을 시작했습니다.`);
  await renderBlocks();
});

refreshButton.addEventListener("click", renderBlocks);

renderBlocks();
setInterval(renderBlocks, 15000);

async function renderBlocks() {
  const response = await sendMessage({ type: "GET_BLOCKS" });
  blockList.textContent = "";

  if (!response.ok) {
    blockList.append(createEmptyItem("목록을 불러오지 못했습니다."));
    return;
  }

  const blocks = response.blocks.sort((a, b) => a.expiresAt - b.expiresAt);
  if (blocks.length === 0) {
    blockList.append(createEmptyItem("현재 차단 중인 사이트가 없습니다."));
    return;
  }

  for (const block of blocks) {
    const item = document.createElement("li");
    item.className = "blockItem";

    const detail = document.createElement("div");
    const host = document.createElement("div");
    host.className = "host";
    host.textContent = block.hostname;

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = `${formatRemaining(block.expiresAt)} 남음`;

    detail.append(host, time);

    item.append(detail);
    blockList.append(item);
  }
}

function createEmptyItem(message) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = message;
  return item;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function formatRemaining(expiresAt) {
  const remainingMs = Math.max(0, expiresAt - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분`;
  }

  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }

  return `${seconds}초`;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
