importScripts('common.js', 'parser.js', 'crawler.js');

let activeJob = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadPage(tabId, address, offset) {
  const url = `${address.url}&st=${offset}`;
  await chrome.tabs.update(tabId, {url});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await delay(500);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') continue;
    if (tab.url !== url) {
      // Canonical host redirects are allowed; topic and offset must match.
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

async function runJob(job, command) {
  let tabId;
  // Extension API calls keep an active crawl alive; interruption is still safe.
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const existing = await dbGet('topics', job.topicId);
    if (command === 'add' && existing?.lastPostId) {
      await chrome.storage.session.set({job: {...job, state: 'done', message: 'Тема уже отслеживается. Точка сохранена.'}});
      return;
    }
    const baseline = command === 'add' || command === 'reset' || !existing?.lastPostId;
    tabId = (await chrome.tabs.create({url: 'about:blank', active: false})).id;
    let count = 0;
    const result = await crawlTopic(async offset => {
      await chrome.storage.session.set({job: {...job, state: 'running', message: `Загрузка страницы st=${offset} (${++count})…`}});
      return loadPage(tabId, job, offset);
    }, existing?.lastPostId, baseline, existing?.firstPostId);
    const createdAt = new Date().toISOString();
    const topic = {...existing, topicId: job.topicId, url: job.url,
      title: result.title || existing?.title || `Тема ${job.topicId}`,
      addedAt: existing?.addedAt || createdAt, lastCheckedAt: createdAt,
      firstPostId: result.firstPostId, lastPostId: result.lastPostId, revision: crypto.randomUUID()};
    const posts = result.posts.map(p => ({...p, topicId: job.topicId, collectedAt: createdAt}));
    const batch = posts.length ? {batchId: `${job.topicId}_${crypto.randomUUID()}`, topicId: job.topicId,
      createdAt, postIds: posts.map(p => p.postId)} : null;
    await commitCollection(existing, topic, posts, batch);
    await chrome.storage.session.set({job: {...job, state: 'done', batchId: batch?.batchId,
      message: baseline ? `${command === 'add' || !existing ? 'Тема добавлена.' : 'Точка отслеживания установлена.'} Новые сообщения будут собираться начиная со следующего поста.` :
        `Готово. Новых постов: ${posts.length}. Последний обработанный: #${topic.lastPostId}.`}});
  } catch (error) {
    await chrome.storage.session.set({job: {...job, state: 'error', message: `${error.message || error}. Незавершённый сбор не изменяет точку отслеживания.`}});
  } finally {
    clearInterval(heartbeat);
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
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
        job = {...job, state: 'error', message: 'Сбор прерван перезапуском расширения. Повторите проверку: точка не продвинута незавершённым сбором.'};
        await chrome.storage.session.set({job});
      }
      return {job};
    }
    if (message.type !== 'start' || !['add', 'check', 'reset', 'delete'].includes(message.command)) throw new Error('Неизвестная команда.');
    if (activeJob) throw new Error('Уже выполняется сбор. Дождитесь его завершения.');
    const address = topicAddress(message.url);
    activeJob = {...address, state: 'running', message: 'Начинаю…'};
    try {
      if (message.command === 'delete') {
        await dbDelete('topics', address.topicId);
        activeJob = null;
        return {ok: true};
      }
      await chrome.storage.session.set({job: activeJob});
      void runJob(activeJob, message.command);
      return {ok: true};
    } catch (error) { activeJob = null; throw error; }
  })().then(sendResponse, error => sendResponse({error: error.message || String(error)}));
  return true;
});
