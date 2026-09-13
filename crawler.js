function compareIds(a, b) {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

function topicAddress(raw) {
  const u = new URL(raw);
  const topicId = u.searchParams.get('showtopic');
  if (u.protocol !== 'https:' || !['4pda.to', '4pda.ru'].includes(u.hostname) ||
      u.pathname !== '/forum/index.php' || !/^\d+$/.test(topicId || '')) {
    throw new Error('Откройте HTTPS-страницу темы 4PDA.');
  }
  return {topicId, url: `${u.origin}/forum/index.php?showtopic=${topicId}`};
}

// load(offset) must return a validated page. No persistence before the complete walk.
async function crawlTopic(load, lastPostId, baseline = false, knownFirstPostId = null) {
  const first = await load(0);
  const firstPostId = knownFirstPostId || first.posts.map(p => p.postId).sort(compareIds)[0];
  let page = first;
  const visitedLast = new Set();
  while (true) {
    const last = Math.max(...page.offsets);
    if (last <= page.offset) break;
    if (visitedLast.has(last)) throw new Error('Зацикливание пагинации.');
    visitedLast.add(last);
    page = await load(last);
  }
  const latest = page.posts.map(p => p.postId).sort(compareIds).at(-1);
  if (baseline || !lastPostId) return {firstPostId, lastPostId: latest, posts: [], title: first.topicTitle};
  const posts = new Map();
  const visited = new Set();
  while (true) {
    if (visited.has(page.offset)) throw new Error('Зацикливание пагинации.');
    visited.add(page.offset);
    const ordinary = page.posts.filter(p => p.postId !== firstPostId);
    for (const post of ordinary) {
      if (compareIds(post.postId, lastPostId) > 0 && compareIds(post.postId, latest) <= 0) posts.set(post.postId, post);
    }
    if (page.offset === 0 || ordinary.some(p => compareIds(p.postId, lastPostId) <= 0)) break;
    const previous = page.previousOffset;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= page.offset) {
      throw new Error('Не удалось надёжно определить предыдущую страницу. Точка отслеживания сохранена.');
    }
    page = await load(previous);
  }
  const sorted = [...posts.values()].sort((a, b) => compareIds(a.postId, b.postId));
  return {firstPostId, lastPostId: sorted.at(-1)?.postId || lastPostId, posts: sorted, title: first.topicTitle};
}
