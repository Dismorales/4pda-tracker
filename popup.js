let lastMarkdown = "";
let lastFilename = "";
let shownBatchId = null;
const statusEl = document.getElementById("status");
const actionsEl = document.getElementById("actions");
const topicResultsEl = document.getElementById("topicResults");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function start(command) {
  try {
    let url;
    if (!['checkAll', 'collectAll'].includes(command)) {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      url = tab?.url;
    }
    const result = await chrome.runtime.sendMessage({type: "start", command, url});
    if (result.error) throw new Error(result.error);
    await updateStatus();
  } catch (error) { setStatus(error.message, "error"); }
}

async function updateStatus() {
  try {
    const {job, error} = await chrome.runtime.sendMessage({type: "status"});
    if (error) throw new Error(error);
    if (!job) return;
    setStatus(job.message, job.state === "error" || job.hasErrors ? "error" : job.state === "done" ? "ok" : "");
    document.querySelectorAll('[data-job]').forEach(button => { button.disabled = job.state === "running"; });
    renderTopicResults(job);
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

function renderTopicResults(job) {
  if (!['checkAll', 'collectAll'].includes(job.command) || !job.results) {
    topicResultsEl.hidden = true;
    return;
  }
  const rows = job.results.map(result => {
    const row = document.createElement('div');
    row.className = `result-row ${result.state === 'error' ? 'error' : ''}`;
    const title = document.createElement('span');
    title.textContent = result.title || `Тема ${result.topicId}`;
    const value = document.createElement('strong');
    if (result.state === 'error') {
      value.textContent = `Ошибка: ${result.error}`;
    } else if (job.command === 'checkAll') {
      value.textContent = result.totalUncollected
        ? `${result.totalUncollected} (+${result.sinceLastCheck})`
        : '0';
    } else {
      value.textContent = result.collected ? `Собрано: ${result.collected}` : 'Нет новых';
    }
    row.append(title, value);
    return row;
  });
  if (job.command === 'checkAll' && job.lastSuccessfulCheckAt) {
    const checked = document.createElement('div');
    checked.className = 'muted result-time';
    checked.textContent = `Последняя успешная проверка: ${new Date(job.lastSuccessfulCheckAt).toLocaleString('ru-RU')}`;
    rows.push(checked);
  }
  topicResultsEl.replaceChildren(...rows);
  topicResultsEl.hidden = false;
}

document.getElementById("addCurrent").onclick = () => start("add");
document.getElementById("collectCurrent").onclick = () => start("check");
document.getElementById("checkAll").onclick = () => start("checkAll");
document.getElementById("collectAll").onclick = () => start("collectAll");
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

