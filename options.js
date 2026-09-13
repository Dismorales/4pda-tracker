async function render() {
  const topics = sortTopics(await dbGetAll("topics"));
  const batches = (await dbGetAll("batches"))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const topicsEl = document.getElementById("topics");
  const topicCards = [];

  for (const topic of topics) {
    const div = document.createElement("div");
    div.className = "topic-row";
    div.dataset.topicId = topic.topicId;
    div.innerHTML = `
      <div class="topic-heading">
        <button class="drag-handle" draggable="true" data-drag-topic="${escapeHtml(topic.topicId)}" title="Перетащить тему" aria-label="Перетащить тему">⋮⋮</button>
        <strong>${escapeHtml(topic.title || `Тема ${topic.topicId}`)}</strong>
      </div>
      <div class="muted">ID: ${topic.topicId}</div>
      <div class="muted">Последний пост: ${topic.lastPostId ? "#" + topic.lastPostId : "не задан"}</div>
      <div class="muted">Последняя успешная проверка: ${topic.lastCheckedAt ? new Date(topic.lastCheckedAt).toLocaleString("ru-RU") : "ещё не выполнялась"}</div>
      <div class="row-actions">
        <button data-check="${escapeHtml(topic.url)}">Собрать</button>
        <button data-open="${escapeHtml(topic.url)}">Открыть</button>
        <button data-reset="${escapeHtml(topic.url)}">Сбросить точку отслеживания</button>
        <button data-delete="${escapeHtml(topic.url)}">Удалить тему</button>
      </div>
    `;
    topicCards.push(div);
  }
  replaceCards(topicsEl, topicCards, "Тем пока нет.");

  const batchesEl = document.getElementById("batches");
  const batchCards = [];

  for (const batch of batches.slice(0, 100)) {
    const topic = await dbGet("topics", batch.topicId);
    const div = document.createElement("div");
    div.className = `batch-row${batch.reviewed === true ? " reviewed" : ""}`;
    div.innerHTML = `
      <strong>${escapeHtml(topic?.title || `Тема ${batch.topicId}`)}</strong>
      <div class="muted">${new Date(batch.createdAt).toLocaleString("ru-RU")} · ${batch.postIds.length} постов</div>
      <div class="row-actions">
        <button data-copybatch="${escapeHtml(batch.batchId)}">Скопировать</button>
        <button data-downloadbatch="${escapeHtml(batch.batchId)}">Скачать .md</button>
        <button class="review-toggle" data-reviewbatch="${escapeHtml(batch.batchId)}" aria-pressed="${batch.reviewed === true}">${batch.reviewed === true ? "✓ Разобрано" : "Разобрано"}</button>
      </div>
    `;
    batchCards.push(div);
  }
  replaceCards(batchesEl, batchCards, "Сборок пока нет.");

  wireEvents();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function getBatchData(batchId) {
  const batch = await dbGet("batches", batchId);
  if (!batch) throw new Error("Сборка не найдена.");
  const topic = await dbGet("topics", batch.topicId) || {topicId: batch.topicId, title: `Тема ${batch.topicId}`, url: `https://4pda.to/forum/index.php?showtopic=${batch.topicId}`};
  const posts = [];
  for (const id of batch.postIds) {
    const p = await dbGet("posts", id);
    if (p) posts.push(p);
  }
  return {batch, topic, posts};
}

function wireEvents() {
  wireTopicDragAndDrop();

  document.querySelectorAll("[data-open]").forEach(btn => {
    btn.onclick = () => chrome.tabs.create({url: btn.dataset.open});
  });

  for (const command of ["check", "reset", "delete"]) {
    document.querySelectorAll(`[data-${command}]`).forEach(btn => {
      btn.onclick = async () => {
        if (command === "reset" && !confirm("Установить точку на последний пост темы? Накопленные новые сообщения будут пропущены, история сохранится.")) return;
        try {
          const response = await chrome.runtime.sendMessage({type: "start", command, url: btn.dataset[command]});
          if (response.error) throw new Error(response.error);
          if (command === "delete") await render();
          else await updateStatus();
        } catch (error) { document.getElementById("status").textContent = error.message; }
      };
    });
  }

  document.querySelectorAll("[data-copybatch]").forEach(btn => {
    btn.onclick = async () => {
      const {batch, topic, posts} = await getBatchData(btn.dataset.copybatch);
      await navigator.clipboard.writeText(buildMarkdown(batch, topic, posts));
      btn.textContent = "Скопировано";
    };
  });

  document.querySelectorAll("[data-downloadbatch]").forEach(btn => {
    btn.onclick = async () => {
      const {batch, topic, posts} = await getBatchData(btn.dataset.downloadbatch);
      const md = buildMarkdown(batch, topic, posts);
      const blob = new Blob([md], {type: "text/markdown;charset=utf-8"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = sanitizeFilename(
        `${topic.title}_${topic.topicId}_${batch.createdAt.slice(0,10)}`
      ) + ".md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  });

  document.querySelectorAll("[data-reviewbatch]").forEach(btn => {
    btn.onclick = async () => {
      const batch = await dbGet("batches", btn.dataset.reviewbatch);
      if (!batch) return;
      await dbPut("batches", {...batch, reviewed: batch.reviewed !== true});
      await render();
    };
  });
}

function wireTopicDragAndDrop() {
  const topicsEl = document.getElementById("topics");
  let draggedCard = null;

  const clearDragState = () => {
    topicsEl.querySelectorAll(".topic-row").forEach(card => {
      card.classList.remove("dragging", "drop-before", "drop-after");
    });
    draggedCard = null;
  };

  topicsEl.querySelectorAll("[data-drag-topic]").forEach(handle => {
    handle.ondragstart = event => {
      draggedCard = handle.closest(".topic-row");
      draggedCard.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedCard.dataset.topicId);
    };
    handle.ondragend = clearDragState;
  });

  topicsEl.querySelectorAll(".topic-row").forEach(card => {
    card.ondragover = event => {
      if (!draggedCard || card === draggedCard) return;
      event.preventDefault();
      const before = event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
      card.classList.toggle("drop-before", before);
      card.classList.toggle("drop-after", !before);
    };
    card.ondragleave = () => card.classList.remove("drop-before", "drop-after");
    card.ondrop = async event => {
      if (!draggedCard || card === draggedCard) return;
      event.preventDefault();
      const before = event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2;
      topicsEl.insertBefore(draggedCard, before ? card : card.nextSibling);
      const topicIds = [...topicsEl.querySelectorAll(".topic-row")].map(row => row.dataset.topicId);
      clearDragState();
      const topics = await dbGetAll("topics");
      const byId = new Map(topics.map(topic => [String(topic.topicId), topic]));
      await Promise.all(topicIds.map((topicId, sortOrder) => {
        const topic = byId.get(topicId);
        return topic ? dbPut("topics", {...topic, sortOrder}) : Promise.resolve();
      }));
      await render();
    };
  });
}

function setBackupStatus(message, isError = false) {
  const status = document.getElementById("backupStatus");
  status.textContent = message;
  status.className = isError ? "error" : "ok";
}

document.getElementById("exportBackup").onclick = async () => {
  try {
    const backup = await createBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type: "application/json;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `4pda-tracker-backup-${backup.exportedAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupStatus("Резервная копия скачана.");
  } catch (error) {
    setBackupStatus(error.message || String(error), true);
  }
};

const backupFile = document.getElementById("backupFile");
document.getElementById("importBackup").onclick = () => {
  backupFile.value = "";
  backupFile.click();
};
backupFile.onchange = async () => {
  const file = backupFile.files?.[0];
  if (!file) return;
  try {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      throw new Error("Файл не содержит корректный JSON.");
    }
    validateBackup(backup);
    if (!confirm("Текущие темы, посты и сборки будут заменены данными из резервной копии. Продолжить?")) return;
    await restoreBackup(backup);
    await render();
    setBackupStatus("Данные успешно восстановлены из резервной копии.");
  } catch (error) {
    setBackupStatus(error.message || String(error), true);
  } finally {
    backupFile.value = "";
  }
};

async function updateStatus(refreshLists = true) {
  const {job} = await chrome.runtime.sendMessage({type: "status"});
  if (!job) return;
  const status = document.getElementById("status");
  status.textContent = job.message;
  status.className = job.state === "error" ? "error" : "";
  if (refreshLists && job.state !== "running") await render();
  document.querySelectorAll("[data-check], [data-reset], [data-delete]").forEach(btn => { btn.disabled = job.state === "running"; });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.job) void updateStatus();
});
void (async () => {
  await updateStatus(false);
  await render();
})();
