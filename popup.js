let lastMarkdown = "";
let lastFilename = "";
let shownBatchId = null;
const statusEl = document.getElementById("status");
const actionsEl = document.getElementById("actions");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function start(command) {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = await chrome.runtime.sendMessage({type: "start", command, url: tab?.url});
    if (result.error) throw new Error(result.error);
    await updateStatus();
  } catch (error) { setStatus(error.message, "error"); }
}

async function updateStatus() {
  try {
    const {job, error} = await chrome.runtime.sendMessage({type: "status"});
    if (error) throw new Error(error);
    if (!job) return;
    setStatus(job.message, job.state === "error" ? "error" : job.state === "done" ? "ok" : "");
    document.getElementById("addCurrent").disabled = job.state === "running";
    document.getElementById("collectCurrent").disabled = job.state === "running";
    if (job.batchId && shownBatchId !== job.batchId) {
      const batch = await dbGet("batches", job.batchId);
      const topic = await dbGet("topics", batch.topicId) || {topicId: batch.topicId, title: `Тема ${batch.topicId}`, url: job.url};
      const posts = (await Promise.all(batch.postIds.map(id => dbGet("posts", id)))).filter(Boolean);
      lastMarkdown = buildMarkdown(batch, topic, posts);
      lastFilename = sanitizeFilename(`${topic.title}_${topic.topicId}_${batch.createdAt.slice(0, 10)}`) + ".md";
      shownBatchId = batch.batchId;
      actionsEl.hidden = false;
    }
  } catch (error) { setStatus(error.message, "error"); }
}

document.getElementById("addCurrent").onclick = () => start("add");
document.getElementById("collectCurrent").onclick = () => start("check");
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.job) void updateStatus();
});
void updateStatus();

document.getElementById("copy").addEventListener("click", async () => {
  if (!lastMarkdown) return;
  await navigator.clipboard.writeText(lastMarkdown);
  setStatus("Скопировано в буфер.", "ok");
});

document.getElementById("download").addEventListener("click", () => {
  if (!lastMarkdown) return;
  const blob = new Blob([lastMarkdown], {type: "text/markdown;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = lastFilename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

