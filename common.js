const DB_NAME = "4pda_tracker_db";
const DB_VERSION = 1;
const BACKUP_FORMAT = "4pda-tracker-backup";
const BACKUP_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("topics")) {
        const s = db.createObjectStore("topics", {keyPath: "topicId"});
        s.createIndex("url", "url", {unique: true});
      }

      if (!db.objectStoreNames.contains("posts")) {
        const s = db.createObjectStore("posts", {keyPath: "postId"});
        s.createIndex("topicId", "topicId", {unique: false});
        s.createIndex("collectedAt", "collectedAt", {unique: false});
      }

      if (!db.objectStoreNames.contains("batches")) {
        const s = db.createObjectStore("batches", {keyPath: "batchId"});
        s.createIndex("createdAt", "createdAt", {unique: false});
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Ошибка транзакции IndexedDB.'));
    tx.onabort = () => reject(tx.error || new Error('Сохранение отменено: тема или точка отслеживания изменились.'));
  });
}

async function dbPut(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
  db.close();
}

async function dbGet(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const req = tx.objectStore(store).get(key);
  const value = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function dbGetAll(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const req = tx.objectStore(store).getAll();
  const values = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return values;
}

function sortTopics(topics) {
  return [...topics].sort((a, b) => {
    const aHasOrder = Number.isFinite(a.sortOrder);
    const bHasOrder = Number.isFinite(b.sortOrder);
    if (aHasOrder && bHasOrder && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (aHasOrder !== bHasOrder) return aHasOrder ? 1 : -1;
    const byTitle = (a.title || '').localeCompare(b.title || '', 'ru');
    return byTitle || String(a.topicId).localeCompare(String(b.topicId), 'en', {numeric: true});
  });
}

function nextTopicSortOrder(topics) {
  const assigned = topics.map(topic => topic.sortOrder).filter(Number.isFinite);
  return assigned.length ? Math.max(...assigned) + 1 : 0;
}

async function createBackup() {
  const [topics, posts, batches] = await Promise.all([
    dbGetAll('topics'),
    dbGetAll('posts'),
    dbGetAll('batches')
  ]);
  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {topics, posts, batches}
  };
}

function validateBackup(backup) {
  const fail = message => { throw new Error(`Некорректная резервная копия: ${message}`); };
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(backup)) fail('ожидался JSON-объект.');
  if (backup.format !== BACKUP_FORMAT) fail('неверная сигнатура формата.');
  if (backup.backupVersion !== BACKUP_VERSION) fail(`версия ${backup.backupVersion} не поддерживается.`);
  if (typeof backup.exportedAt !== 'string' || !backup.exportedAt || Number.isNaN(Date.parse(backup.exportedAt))) {
    fail('неверная дата создания.');
  }
  if (!isObject(backup.data)) fail('отсутствует раздел data.');

  const specs = {
    topics: record => typeof record.topicId === 'string' && record.topicId.length > 0 &&
      typeof record.url === 'string' && record.url.length > 0,
    posts: record => typeof record.postId === 'string' && record.postId.length > 0 &&
      typeof record.topicId === 'string' && record.topicId.length > 0,
    batches: record => typeof record.batchId === 'string' && record.batchId.length > 0 &&
      typeof record.topicId === 'string' && record.topicId.length > 0 &&
      typeof record.createdAt === 'string' && record.createdAt.length > 0 && Array.isArray(record.postIds)
  };
  const primaryKeys = {topics: 'topicId', posts: 'postId', batches: 'batchId'};

  for (const [store, isValid] of Object.entries(specs)) {
    const records = backup.data[store];
    if (!Array.isArray(records)) fail(`${store} должен быть массивом.`);
    const seen = new Set();
    for (const record of records) {
      if (!isObject(record) || !isValid(record)) fail(`запись ${store} не содержит обязательных полей.`);
      const key = record[primaryKeys[store]];
      if (seen.has(key)) fail(`повторяющийся ключ ${store}: ${key}.`);
      seen.add(key);
    }
  }

  const topicUrls = new Set();
  for (const topic of backup.data.topics) {
    if (topicUrls.has(topic.url)) fail(`повторяющийся URL темы: ${topic.url}.`);
    topicUrls.add(topic.url);
  }
  return backup.data;
}

async function restoreBackup(backup) {
  const data = validateBackup(backup);
  const db = await openDb();
  try {
    const tx = db.transaction(['topics', 'posts', 'batches'], 'readwrite');
    const done = txDone(tx);
    try {
      for (const storeName of ['topics', 'posts', 'batches']) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const record of data[storeName]) store.put(record);
      }
    } catch (error) {
      tx.abort();
      await done.catch(() => {});
      throw error;
    }
    await done;
  } finally {
    db.close();
  }
}

async function dbDelete(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
  db.close();
}

// Compare the starting point inside the same transaction as all writes. An old
// collector must not overwrite a reset/deletion or a newer successful run.
async function commitCollection(expected, topic, posts, batch) {
  const db = await openDb();
  try {
    const tx = db.transaction(['topics', 'posts', 'batches'], 'readwrite');
    const done = txDone(tx);
    const request = tx.objectStore('topics').get(topic.topicId);
    request.onsuccess = () => {
      const current = request.result;
      if (Boolean(current) !== Boolean(expected) ||
          (current && (current.lastPostId !== expected.lastPostId || current.revision !== expected.revision))) {
        tx.abort();
        return;
      }
      try {
        for (const post of posts) tx.objectStore('posts').put(post);
        if (batch) tx.objectStore('batches').put(batch);
        tx.objectStore('topics').put(topic);
      } catch {
        tx.abort();
      }
    };
    await done;
  } finally {
    db.close();
  }
}

