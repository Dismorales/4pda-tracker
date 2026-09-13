const DB_NAME = "4pda_tracker_db";
const DB_VERSION = 1;

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

