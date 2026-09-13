importScripts('common.js', 'parser.js', 'crawler.js');

let activeJob = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function publishJob(patch = {}) {
  if (!activeJob) return;
  Object.assign(activeJob, patch);
  await chrome.storage.session.set({job: {...activeJob}});
}

async function loadPage(tabId, address, offset) {
  const url = `${address.url}&st=${offset}`;
  await chrome.tabs.update(tabId, {url});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await delay(500);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') continue;
    if (tab.url !== url) {
      const actual = topicAddress(tab.url);
      if (actual.topicId !== address.topicId || Number(new URL(tab.url).searchParams.get('st') || 0) !== offset) {
        throw new Error('Вкладка перенаправлена: проверьте вход или защиту 4PDA.');
      }
    }
    const [{result}] = await chrome.scripting.executeScript({target: {tabId}, func: collect4pdaCurrentPage});
    if (!result || result.error) throw new Error(result?.error || 'Не удалось разобрать страницу.');
    if (result.topicId !== address.topicId || result.offset !== offset) throw new Error('Получена другая страница темы.');
    return result;
  }
  throw new Error('Страница не загрузилась за 60 секунд. Повторите проверку.');
}

async function crawlInTab(address, sincePostId, baseline, firstPostId, progress) {
  let tabId;
  try {
    tabId = (await chrome.tabs.create({url: 'about:blank', active: false})).id;
    let pageCount = 0;
    return await crawlTopic(async offset => {
      pageCount += 1;
      await progress(`Загрузка ${address.topicId}: st=${offset} (${pageCount})…`);
      return loadPage(tabId, address, offset);
    }, sincePostId, baseline, firstPostId);
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function topicAfterSuccess(existing, address, result, createdAt, fields = {}) {
  return {
    ...existing,
    topicId: address.topicId,
    url: address.url,
    title: result.title || existing?.title || `Тема ${address.topicId}`,
    addedAt: existing?.addedAt || createdAt,
    lastCheckedAt: createdAt,
    firstPostId: result.firstPostId,
    revision: crypto.randomUUID(),
    ...fields
  };
}

async function collectTopic(address, existing, command, progress, topicFields = {}) {
  const baseline = command === 'add' || command === 'reset' || !existing?.lastPostId;
  const result = await crawlInTab(address, existing?.lastPostId, baseline, existing?.firstPostId, progress);
  const createdAt = new Date().toISOString();
  const topic = topicAfterSuccess(existing, address, result, createdAt, {
    ...topicFields,
    lastPostId: result.lastPostId,
    lastCheckedPostId: result.lastPostId
  });
  const posts = result.posts.map(post => ({...post, topicId: address.topicId, collectedAt: createdAt}));
  const batch = posts.length ? {
    batchId: `${address.topicId}_${crypto.randomUUID()}`,
    topicId: address.topicId,
    createdAt,
    postIds: posts.map(post => post.postId)
  } : null;
  await commitCollection(existing, topic, posts, batch);
  return {topic, posts, batch, baseline};
}

async function inspectTopic(address, existing, progress) {
  if (!existing?.lastPostId) throw new Error('Не задана точка сборки. Добавьте тему заново или сбросьте точку.');
  const checkedFrom = existing.lastCheckedPostId || existing.lastPostId;
  const crawlFrom = compareIds(checkedFrom, existing.lastPostId) < 0 ? checkedFrom : existing.lastPostId;
  const result = await crawlInTab(address, crawlFrom, false, existing.firstPostId, progress);
  const totalUncollected = result.posts.filter(post => compareIds(post.postId, existing.lastPostId) > 0).length;
  const sinceLastCheck = result.posts.filter(post => compareIds(post.postId, checkedFrom) > 0).length;
  const checkedAt = new Date().toISOString();
  const topic = topicAfterSuccess(existing, address, result, checkedAt, {
    lastPostId: existing.lastPostId,
    lastCheckedPostId: result.lastPostId
  });
  // This transaction writes only the topic record. No posts or batch are created.
  await commitCollection(existing, topic, [], null);
  return {topic, totalUncollected, sinceLastCheck, checkedAt};
}

async function runSingle(job, command) {
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const existing = await dbGet('topics', job.topicId);
    if (command === 'add' && existing?.lastPostId) {
      await publishJob({state: 'done', message: 'Тема уже отслеживается. Точки сохранены.'});
      return;
    }
    const topicFields = command === 'add' && !existing
      ? {sortOrder: nextTopicSortOrder(await dbGetAll('topics'))}
      : {};
    const result = await collectTopic(job, existing, command, message => publishJob({message}), topicFields);
    await publishJob({
      state: 'done',
      batchId: result.batch?.batchId,
      message: result.baseline
        ? `${command === 'add' || !existing ? 'Тема добавлена.' : 'Точки отслеживания установлены.'} Новые сообщения будут собираться начиная со следующего поста.`
        : `Готово. Новых постов: ${result.posts.length}. Последний обработанный: #${result.topic.lastPostId}.`
    });
  } catch (error) {
    await publishJob({state: 'error', message: `${error.message || error}. Незавершённый сбор не изменяет точки отслеживания.`});
  } finally {
    clearInterval(heartbeat);
    activeJob = null;
  }
}

async function runAll(job, command) {
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const topics = sortTopics(await dbGetAll('topics'));
    const results = [];
    await publishJob({results, message: topics.length ? `Тем: ${topics.length}. Начинаю…` : 'Нет отслеживаемых тем.'});
    for (let index = 0; index < topics.length; index += 1) {
      const existing = topics[index];
      const base = {topicId: existing.topicId, title: existing.title || `Тема ${existing.topicId}`};
      await publishJob({results, message: `${index + 1}/${topics.length}: ${base.title}`});
      try {
        const address = topicAddress(existing.url);
        if (command === 'checkAll') {
          const checked = await inspectTopic(address, existing, message => publishJob({results, message}));
          results.push({...base, title: checked.topic.title, state: 'done',
            totalUncollected: checked.totalUncollected, sinceLastCheck: checked.sinceLastCheck});
        } else {
          const collected = await collectTopic(address, existing, 'collectAll', message => publishJob({results, message}));
          results.push({...base, title: collected.topic.title, state: 'done',
            collected: collected.posts.length, batchId: collected.batch?.batchId});
        }
      } catch (error) {
        results.push({...base, state: 'error', error: error.message || String(error)});
      }
      await publishJob({results: [...results]});
    }
    const errors = results.filter(result => result.state === 'error').length;
    let lastSuccessfulCheckAt = job.lastSuccessfulCheckAt || null;
    if (command === 'checkAll' && !errors) {
      lastSuccessfulCheckAt = new Date().toISOString();
      await chrome.storage.local.set({lastSuccessfulCheckAt});
    }
    await publishJob({
      state: 'done',
      results,
      completedAt: new Date().toISOString(),
      lastSuccessfulCheckAt,
      hasErrors: Boolean(errors),
      message: errors ? `Завершено с ошибками: ${errors} из ${results.length}.` : `Готово. Обработано тем: ${results.length}.`
    });
  } catch (error) {
    await publishJob({state: 'error', message: error.message || String(error)});
  } finally {
    clearInterval(heartbeat);
    activeJob = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id ||
      !['popup.html', 'options.html'].some(path => sender.url === chrome.runtime.getURL(path))) return;
  (async () => {
    if (message.type === 'status') {
      let {job} = await chrome.storage.session.get('job');
      if (job?.state === 'running' && !activeJob) {
        job = {...job, state: 'error', message: 'Операция прервана перезапуском расширения. Незавершённые темы не изменены.'};
        await chrome.storage.session.set({job});
      }
      return {job};
    }
    const commands = ['add', 'check', 'reset', 'delete', 'checkAll', 'collectAll'];
    if (message.type !== 'start' || !commands.includes(message.command)) throw new Error('Неизвестная команда.');
    if (activeJob) throw new Error('Уже выполняется операция. Дождитесь её завершения.');

    if (message.command === 'checkAll' || message.command === 'collectAll') {
      const {lastSuccessfulCheckAt} = await chrome.storage.local.get('lastSuccessfulCheckAt');
      activeJob = {command: message.command, state: 'running', message: 'Начинаю…', results: [], lastSuccessfulCheckAt};
      await publishJob();
      void runAll(activeJob, message.command);
      return {ok: true};
    }

    const address = topicAddress(message.url);
    if (message.command === 'delete') {
      await dbDelete('topics', address.topicId);
      return {ok: true};
    }
    activeJob = {...address, command: message.command, state: 'running', message: 'Начинаю…'};
    await publishJob();
    void runSingle(activeJob, message.command);
    return {ok: true};
  })().then(sendResponse, error => sendResponse({error: error.message || String(error)}));
  return true;
});
