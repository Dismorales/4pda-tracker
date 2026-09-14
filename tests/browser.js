/* Run only in the standalone tests/run.html origin, never in the extension. */
(async () => {
  const output = document.getElementById('results');
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function test(name, fn) {
    try { await fn(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.stack || error}`); }
    output.textContent = results.join('\n');
  }
  const topicUrl = 'https://4pda.to/forum/index.php?showtopic=1109483';
  const findPost = id => `${topicUrl}&view=findpost&p=${id}`;
  const post = (id, date, body, extra = '') => `<table class="ipbtable"><tbody>
    <tr><td><span class="normalname">author${id}</span></td><td class="postdetails">#12 ${date}${extra}</td></tr>
    <tr><td id="post-main-${id}"><div class="postcolor" id="post-${id}">${body}</div></td></tr>
    </tbody></table>`;
  function parse(html, offset = 40) {
    const doc = new DOMParser().parseFromString(`<base href="${topicUrl}"><h1>Fixture</h1>${html}`, 'text/html');
    return collect4pdaCurrentPage(doc, `${topicUrl}&st=${offset}`);
  }
  await test('Different pages get their real topic titles, never helper heading', () => {
    const makePage = (title, id) => {
      const doc = new DOMParser().parseFromString(
        `<title>${title} - 4PDA</title><h1>[X]Помощник</h1>${post(id, 'Сегодня, 13:31', 'Текст')}`,
        'text/html');
      return collect4pdaCurrentPage(doc, `${topicUrl}&st=0`).topicTitle;
    };
    const first = makePage('Revvl 7 Pro - Обсуждение', '145041218');
    const second = makePage('Google Pixel 10 - Обсуждение', '145041219');
    assert(first === 'Revvl 7 Pro - Обсуждение', `first title: ${first}`);
    assert(second === 'Google Pixel 10 - Обсуждение', `second title: ${second}`);
    assert(first !== second && !first.includes('Помощник') && !second.includes('Помощник'), 'same helper title');
  });
  await test('Two complete renders keep one card per batch', () => {
    const container = document.createElement('div');
    const batches = [
      {batchId: 'one', title: 'Topic A', createdAt: '2026-09-12', postIds: ['1']},
      {batchId: 'two', title: 'Topic B', createdAt: '2026-09-13', postIds: ['2', '3']}
    ];
    const renderFixture = () => replaceCards(container, batches.map(batch => {
      const card = document.createElement('div');
      card.className = 'batch-row';
      card.dataset.batchId = batch.batchId;
      card.textContent = `${batch.title} · ${batch.createdAt} · ${batch.postIds.length}`;
      return card;
    }), 'No batches');
    renderFixture();
    renderFixture();
    assert(container.querySelectorAll('.batch-row').length === batches.length, 'cards duplicated');
    assert(container.querySelectorAll('[data-batch-id="one"]').length === 1, 'first batch duplicated');
    assert(container.querySelectorAll('[data-batch-id="two"]').length === 1, 'second batch duplicated');
  });
  await test('Topic ordering keeps legacy fallback and honors saved order', () => {
    const legacy = [
      {topicId: '2', title: 'Яндекс'},
      {topicId: '1', title: 'Альфа'}
    ];
    assert(sortTopics(legacy).map(topic => topic.topicId).join() === '1,2', 'legacy order is unstable');
    const ordered = legacy.map((topic, sortOrder) => ({...topic, sortOrder}));
    assert(sortTopics(ordered).map(topic => topic.topicId).join() === '2,1', 'saved order ignored');
    assert(nextTopicSortOrder(legacy) === 0 && nextTopicSortOrder(ordered) === 2, 'new topic order is not last');
  });
  await test('Relative/absolute dates, explicit ISO and authors', () => {
    const page = parse(post('145041218', 'Сегодня, 13:31', 'Текст') +
      post('145041224', 'Вчера, 22:15', 'Текст') +
      post('145041462', '12.09.26, 13:31', 'Текст', '<time datetime="2026-09-12T13:31:00+03:00"></time>'));
    assert(!page.error, page.error);
    assert(page.posts[0].datetimeText === 'Сегодня, 13:31', 'today missing');
    assert(page.posts[1].datetimeText === 'Вчера, 22:15', 'yesterday missing');
    assert(page.posts[2].datetimeText === '12.09.26, 13:31', 'absolute missing');
    assert(page.posts[0].datetimeIso === null, 'guessed timezone');
    assert(page.posts[2].datetimeIso === '2026-09-12T10:31:00.000Z', 'ISO');
    assert(page.posts[1].author === 'author145041224', 'wrong author scope');
  });
  await test('Quote headers, reply prefix, arbitrary links and text line breaks', () => {
    const page = parse(post('21', 'Сегодня, 13:31', `<div class="quotetop">kumar03 @ 12.09.26 <a href="${findPost('20')}">↗</a></div><div class="quotemain">secret quote</div>One<br>Two`) +
      post('22', '', `Reference <a href="${findPost('19')}">link</a>`) +
      post('23', '', `<a href="https://4pda.to/forum/index.php?act=findpost&pid=18"></a> <b>nick</b>, Reply`) +
      post('24', '', `<blockquote>arbitrary <a href="${findPost('17')}">link</a></blockquote>`));
    assert(page.posts[0].replyTo.postId === '20', 'quote reference');
    assert(page.posts[0].replyTo.author === 'kumar03', 'quote author');
    assert(page.posts[0].text.includes('[ЦИТАТА ИЗ ПОСТА #20, АВТОР kumar03, УБРАНА]'), 'quote marker');
    assert(!page.posts[0].text.includes('secret quote'), 'quote leaked');
    assert(page.posts[0].text.includes('One\nTwo'), 'line breaks');
    assert(page.posts[1].replyTo === null && page.posts[3].replyTo === null, 'false reply');
    assert(page.posts[2].replyTo.postId === '18', 'explicit reply prefix');
  });
  await test('Quote metadata variants, multiple and nested quotes stay reliable', () => {
    const find = id => `<a href="${findPost(id)}">post</a>`;
    const html =
      post('31', '', `<div class="quotetop" data-post-id="101" data-author="kumar03">Quote</div><div class="quotemain">secret</div>Reply`) +
      post('32', '', `<div class="quotetop">${find('102')}</div><div class="quotemain">secret</div>Reply`) +
      post('33', '', `<div class="quotetop"><b>alice</b></div><div class="quotemain">secret</div>Reply`) +
      post('34', '', `<div class="quotemain">secret</div>Reply`) +
      post('35', '', `<div class="quotetop" data-post="105" data-author="bob">Quote</div><div class="quotemain">one</div>` +
        `<div class="quotetop" data-post_id="106" data-author="carol">Quote</div><div class="quotemain">two</div>Reply`) +
      post('36', '', `<div class="quote"><header data-post-id="107" data-author="outer">Quote</header>` +
        `<div class="quotemain">outer text<div class="quote"><header data-post-id="108" data-author="inner">Nested</header>` +
        `<div class="quotemain">nested text</div></div></div></div>Reply`) +
      post('37', '', `kumar03, ordinary mention ${find('109')}`);
    const posts = parse(html).posts;
    assert(posts[0].text.includes('[ЦИТАТА ИЗ ПОСТА #101, АВТОР kumar03, УБРАНА]'), 'id + author marker');
    assert(posts[0].replyTo.postId === '101' && posts[0].replyTo.author === 'kumar03', 'id + author reply');
    assert(posts[1].text.includes('[ЦИТАТА ИЗ ПОСТА #102 УБРАНА]') && !posts[1].replyTo.author, 'id-only quote');
    assert(posts[2].text.includes('[ЦИТАТА АВТОРА alice УБРАНА]') && posts[2].replyTo.author === 'alice', 'author-only quote');
    assert(posts[3].text.includes('[ЦИТАТА УБРАНА]') && posts[3].replyTo === null, 'anonymous quote');
    assert(posts[4].replyToList.map(reply => reply.postId).join() === '105,106', 'multiple reply order');
    assert((posts[4].text.match(/\[ЦИТАТА/g) || []).length === 2, 'multiple markers');
    assert(posts[5].replyToList.length === 1 && posts[5].replyTo.postId === '107', 'nested reply leaked');
    assert(!posts[5].text.includes('108') && !posts[5].text.includes('nested text'), 'nested quote leaked');
    assert(posts[6].replyTo === null && posts[6].replyToList.length === 0, 'ordinary mention became reply');
  });
  await test('Real 4PDA block-title quote exposes pid and author', () => {
    const html = post('38', '', `<div class="quote"><div class="block-title">
      shashyk @ 12.09.26, 16:48
      <a href="/forum/index.php?act=findpost&amp;pid=145044175" target="_blank" title="Перейти к сообщению"><img src="icon.png"></a>
    </div><div class="quotemain">quoted text with <a href="${findPost('999999999')}">unrelated body link</a></div></div>Reply`) +
      post('39', '', `<blockquote><div class="block-title"><a href="/forum/index.php?act=findpost&amp;pid=145044176"><img src="icon.png"></a></div>quoted</blockquote>Reply`) +
      post('40', '', `<blockquote><div class="block-title">solo_author @ Вчера, 21:10</div>quoted</blockquote>Reply`);
    const parsedPosts = parse(html).posts;
    const parsed = parsedPosts[0];
    assert(parsed.replyTo?.postId === '145044175', `block-title pid: ${parsed.replyTo?.postId}`);
    assert(parsed.replyTo?.author === 'shashyk', `block-title author: ${parsed.replyTo?.author}`);
    assert(parsed.replyToList.length === 1, 'body link or nested content created another reply');
    assert(parsed.text.includes('[ЦИТАТА ИЗ ПОСТА #145044175, АВТОР shashyk, УБРАНА]'), 'block-title marker');
    assert(!parsed.text.includes('quoted text') && !parsed.text.includes('999999999'), 'quote body leaked');
    assert(parsedPosts[1].replyTo.postId === '145044176' && !parsedPosts[1].replyTo.author, 'block-title pid-only fallback');
    assert(parsedPosts[1].text.includes('[ЦИТАТА ИЗ ПОСТА #145044176 УБРАНА]'), 'block-title pid-only marker');
    assert(parsedPosts[2].replyTo.author === 'solo_author' && !parsedPosts[2].replyTo.postId, 'block-title author-only fallback');
    assert(parsedPosts[2].text.includes('[ЦИТАТА АВТОРА solo_author УБРАНА]'), 'block-title author-only marker');
    const md = buildMarkdown({createdAt: '2026-09-12T14:00:00Z'},
      {topicId: '1109483', title: 'Topic', url: topicUrl}, [parsed]);
    assert(md.includes('**Ответ на:** пост #145044175, shashyk'), 'block-title Markdown reply');
    assert(md.includes('[ЦИТАТА ИЗ ПОСТА #145044175, АВТОР shashyk, УБРАНА]'), 'block-title Markdown marker');
  });
  await test('Only confirmed service reply permalinks are removed from post text', () => {
    const service = (id, author, text = '') =>
      `<a href="https://4pda.to/forum/index.php?act=findpost&pid=${id}"></a> <b>${author}</b>, ${text}`;
    const html =
      post('41', '', `${service('201', 'Vecktor22', 'message text')}`) +
      post('42', '', `${service('202', 'first', 'reply')}<div>${service('203', 'other', 'keep other')}</div>` +
        `<a href="https://example.com/page">External</a>`) +
      post('43', '', `<div class="quotetop" data-post-id="205" data-author="alice">Quote</div><div class="quotemain">one</div>` +
        `<div class="quotetop" data-post-id="206" data-author="bob">Quote</div><div class="quotemain">two</div>` +
        `<div>${service('205', 'alice', 'first')}</div>` +
        `<div><a href="${findPost('206')}"></a> <b>bob</b>, second</div>` +
        `<div>${service('207', 'other', 'keep unmatched')}</div>`) +
      post('44', '', `<div class="quotetop" data-post-id="210" data-author="alice">Quote</div><div class="quotemain">one</div>` +
        `See this useful link: <a href="https://4pda.to/forum/index.php?act=findpost&pid=210">details</a>`);
    const posts = parse(html).posts;
    assert(posts[0].replyTo.postId === '201' && !posts[0].text.includes('pid=201'), 'matching service link remained');
    assert(posts[0].text.includes('Vecktor22, message text'), 'author or following text removed');
    assert(!posts[1].text.includes('pid=202'), 'primary service link remained');
    assert(posts[1].text.includes('pid=203'), 'different post link removed');
    assert(posts[1].text.includes('https://example.com/page'), 'external link removed');
    assert(!posts[2].text.includes('pid=205') && !posts[2].text.includes('pid=206'), 'multiple matching links remained');
    assert(posts[2].text.includes('pid=207'), 'unmatched multiple link removed');
    assert(posts[3].text.includes('pid=210') && posts[3].text.includes('details'), 'content link with matching ID removed');
  });
  await test('Content images survive in order while UI images are ignored', () => {
    const html =
      post('51', '', `Before<img src="/content/photo.png" alt="Фото тарифа">After`) +
      post('52', '', `<div class="spoiler"><div class="block-title">тариф Индивидуальный</div>` +
        `<div class="block-body"><img src="images/tariff.jpg" alt=""></div></div>`) +
      post('53', '', `<a href="/forum/dl/post/123/original.webp"><img src="/thumbs/small.jpg" alt="Скриншот"></a>`) +
      post('54', '', `<div class="quote"><div class="block-title">alice @ 12.09.26, 10:00 ` +
        `<a href="${findPost('50')}"><img src="/style_images/quote.png"></a></div>` +
        `<div class="quotemain">quoted</div></div>Reply`) +
      post('55', '', `Hello <img class="smile" src="/style_emoticons/default/smile.gif" alt=":)"> world`) +
      post('56', '', `first text<img src="https://cdn.example.com/middle.jpeg">last text`);
    const posts = parse(html).posts;
    assert(posts[0].text.includes('![Фото тарифа](https://4pda.to/content/photo.png)'), 'ordinary image missing');
    assert(posts[1].text.includes('![тариф Индивидуальный](https://4pda.to/forum/images/tariff.jpg)'), 'spoiler image/title missing');
    assert(posts[2].text.includes('![Скриншот](https://4pda.to/forum/dl/post/123/original.webp)'), 'full-size image not preferred');
    assert(!posts[2].text.includes('/thumbs/small.jpg'), 'thumbnail exported instead of original');
    assert(!posts[3].text.includes('![Ш') && !posts[3].text.includes('quote.png'), 'quote icon exported');
    assert(!posts[4].text.includes('![') && !posts[4].text.includes('smile.gif'), 'smiley exported as content image');
    const ordered = posts[5].text;
    assert(ordered.indexOf('first text') < ordered.indexOf('![изображение]') &&
      ordered.indexOf('![изображение]') < ordered.indexOf('last text'), 'text-image-text order changed');
    const md = buildMarkdown({createdAt: '2026-09-12T14:00:00Z'},
      {topicId: '1109483', title: 'Topic', url: topicUrl}, [posts[1]]);
    assert(md.includes('![тариф Индивидуальный](https://4pda.to/forum/images/tariff.jpg)'), 'image missing from Markdown export');
  });
  await test('Opaque 4PDA findpost star icon is filtered without hiding content GIFs', () => {
    const serviceUrl = 'https://4pda.to/s/mQ60RwKIZz1PFQxMexb5gSBJeDUF9SO5wjSGuib1UEdTaYz1Tsyi.gif';
    const html = post('57', '', `<a href="/forum/index.php?act=findpost&amp;pid=145047446" title="Перейти к сообщению">` +
      `<img alt="*" src="${serviceUrl}"></a> raihem, проверили работу приложения...`) +
      post('58', '', `<img alt="*" src="/uploads/content-star.gif"> содержательная GIF`);
    const posts = parse(html).posts;
    assert(!posts[0].text.includes(serviceUrl) && !posts[0].text.includes('!['), 'findpost star icon exported');
    assert(posts[0].text.includes('raihem, проверили работу приложения...'), 'text after UI icon removed');
    assert(posts[1].text.includes('![изображение](https://4pda.to/uploads/content-star.gif)'), 'content GIF removed because of alt star');
  });
  await test('Edit note, plain reply prefix and attachment representations are cleaned', () => {
    const icon = 'https://4pda.to/s/mQ60RwKIZz1PFQxMexb5gSBJeDUF9SO5wjSGuib1UEdTaYz1Tsyi.gif';
    const html =
      post('60', '', `Useful text<div class="edit">Сообщение отредактировал shashyk - Вчера, 23:12</div>`) +
      post('61', '', `Пользователь написал: Сообщение отредактировал — но это обычный текст.`) +
      post('62', '', `<a href="/forum/index.php?act=findpost&amp;pid=145048191"><img alt="*" src="${icon}"></a>` +
        ` LAVILAFIC, А как вы это отключили?`) +
      post('63', '', `<div class="attachment"><img src="/s/cache/img-resized.png" alt="изображение">` +
        `<a href="/forum/dl/post/36143371/Screenshot_20260913-024243.png">` +
        `<img src="/thumbs/Screenshot_small.png" alt="Прикрепленное изображение"></a></div>` +
        `<a href="/forum/dl/post/36143372/manual.pdf">manual.pdf</a>`) +
      post('64', '', `<a href="/forum/dl/post/36143373/one.png"><img src="/thumbs/one.png" alt="One"></a>` +
        `<a href="/forum/dl/post/36143374/two.png"><img src="/thumbs/two.png" alt="Two"></a>`) +
      post('65', '', `Useful <a href="/forum/index.php?act=findpost&amp;pid=145048191">post link</a> inside text`);
    const posts = parse(html).posts;
    assert(!posts[0].text.includes('Сообщение отредактировал') && posts[0].text.includes('Useful text'), 'DOM edit note remained');
    assert(posts[1].text.includes('Сообщение отредактировал'), 'user-authored edit phrase removed');
    assert(posts[2].replyTo?.postId === '145048191' && posts[2].replyTo?.author === 'LAVILAFIC', 'plain reply prefix metadata');
    assert(!posts[2].text.includes('pid=145048191') && posts[2].text.includes('LAVILAFIC, А как вы это отключили?'), 'plain reply prefix cleanup');
    const original = 'https://4pda.to/forum/dl/post/36143371/Screenshot_20260913-024243.png';
    assert((posts[3].text.match(/!\[/g) || []).length === 1 && posts[3].text.includes(`![Прикрепленное изображение](${original})`), 'resized/original not collapsed');
    assert(!posts[3].text.includes('img-resized.png'), 'technical resized image remained');
    assert(!posts[3].attachments.some(a => a.url === original), 'inline original repeated in attachments');
    assert(posts[3].attachments.some(a => /36143372\/manual\.pdf$/.test(a.url)), 'non-inline attachment lost');
    const md = buildMarkdown({createdAt: '2026-09-13T03:00:00Z'},
      {topicId: '1109483', title: 'Topic', url: topicUrl}, [posts[3]]);
    assert((md.match(/36143371/g) || []).length === 1, 'inline original repeated in Markdown attachments');
    assert(md.includes('**Вложения:**') && md.includes('36143372/manual.pdf'), 'non-inline attachment absent from Markdown');
    assert((posts[4].text.match(/!\[/g) || []).length === 2 && posts[4].text.indexOf('36143373') < posts[4].text.indexOf('36143374'), 'different images merged or reordered');
    assert(posts[5].text.includes('pid=145048191') && posts[5].text.includes('post link'), 'content findpost link removed');
  });
  await test('Wrapped reply prefix and duplicate reply targets are normalized', () => {
    const html =
      post('66', '', `<span class="reply-permalink"><a href="/forum/index.php?act=findpost&amp;pid=145048053">` +
        `<img alt="*" src="/s/reply.gif"></a></span> Serg_1970,<br>Уже решаем с вами вопрос в личке.`) +
      post('67', '', `<div class="quotetop"><a href="${findPost('145050301')}">post</a></div><div class="quotemain">first quote</div>` +
        `на*858# выдает ошибку` +
        `<div class="quotetop" data-post-id="145050301" data-author="Ibif">Quote</div><div class="quotemain">second quote</div>` +
        `симка электрическая`) +
      post('68', '', `<div class="quotetop" data-post-id="301" data-author="same">Quote</div><div class="quotemain">one</div>` +
        `<div class="quotetop" data-post-id="302" data-author="same">Quote</div><div class="quotemain">two</div>`) +
      post('69', '', `Read <a href="/forum/index.php?act=findpost&amp;pid=145048053">this post</a>, it matters`);
    const posts = parse(html).posts;
    assert(posts[0].replyTo?.postId === '145048053' && posts[0].replyTo?.author === 'Serg_1970', 'wrapped prefix metadata');
    assert(!posts[0].text.includes('pid=145048053'), 'wrapped service permalink remained');
    assert(posts[0].text.includes('Serg_1970,\nУже решаем с вами вопрос в личке.'), 'wrapped prefix text changed');
    assert(posts[1].replyToList.length === 1 && posts[1].replyToList[0].postId === '145050301', 'duplicate post ID remained');
    assert(posts[1].replyToList[0].author === 'Ibif', 'known author did not upgrade duplicate');
    assert((posts[1].text.match(/\[ЦИТАТА/g) || []).length === 2, 'duplicate quote marker removed');
    assert(posts[1].text.indexOf('на*858#') < posts[1].text.lastIndexOf('[ЦИТАТА') &&
      posts[1].text.lastIndexOf('[ЦИТАТА') < posts[1].text.indexOf('симка электрическая'), 'quote marker positions changed');
    const md = buildMarkdown({createdAt: '2026-09-13T04:00:00Z'},
      {topicId: '1109483', title: 'Topic', url: topicUrl}, [posts[1]]);
    assert((md.match(/\*\*Ответ на:\*\*/g) || []).length === 1 && md.includes('пост #145050301, Ibif'), 'duplicate Markdown reply line');
    assert((md.match(/\[ЦИТАТА/g) || []).length === 2, 'Markdown quote marker removed');
    assert(posts[2].replyToList.map(reply => reply.postId).join() === '301,302', 'different post IDs deduplicated');
    assert(posts[3].text.includes('pid=145048053') && posts[3].text.includes('this post'), 'visible content findpost removed');
  });
  await test('Exact 4PDA service GIF button is always removed and deduplicated', () => {
    const gif = 'https://4pda.to/s/mQ60RwKIZz1PFQxMexb5gSBJeDUF9SO5wjSGuib1UEdTaYz1Tsyi.gif';
    const button = id => `<a href="/forum/index.php?act=findpost&amp;pid=${id}"><img src="${gif}" alt="*" border="0"></a>`;
    const html =
      post('70', '', `${button('145051508')} Vitaliy474,<br>Возможно предложат.`) +
      post('71', '', `<div class="quotetop" data-post-id="145051509" data-author="Vitaliy474">Quote</div>` +
        `<div class="quotemain">quoted</div>${button('145051509')} Vitaliy474,<br>Reply`) +
      post('72', '', `Read <a href="/forum/index.php?view=findpost&amp;p=145051508">visible post link</a> here`) +
      post('73', '', `Intro text ${button('145051510')} tail text`);
    const posts = parse(html).posts;
    assert(posts[0].replyToList.length === 1 && posts[0].replyTo.postId === '145051508' &&
      posts[0].replyTo.author === 'Vitaliy474', 'service GIF reply metadata');
    assert(!posts[0].text.includes('pid=145051508') && !posts[0].text.includes(gif) && !posts[0].text.includes('!['), 'service GIF/link exported');
    assert(posts[0].text.includes('Vitaliy474,\nВозможно предложат.'), 'text after service GIF changed');
    assert(posts[1].replyToList.length === 1 && posts[1].replyTo.author === 'Vitaliy474', 'existing quote reply duplicated');
    assert((posts[1].text.match(/\[ЦИТАТА/g) || []).length === 1 && !posts[1].text.includes('pid=145051509'), 'quote marker or service link wrong');
    assert(posts[2].text.includes('view=findpost') && posts[2].text.includes('visible post link'), 'normal visible findpost link removed');
    assert(!posts[3].text.includes(gif) && !posts[3].text.includes('pid=145051510') && posts[3].text.includes('Intro text') &&
      posts[3].text.includes('tail text'), 'non-prefix exact service button remained or text changed');
  });
  await test('Pagination derives custom page size and ignores post links', () => {
    const page = parse(`<a href="${topicUrl}&st=0">1</a><a href="${topicUrl}&st=70">3</a><a href="${topicUrl}&st=350">11</a>` +
      post('21', '', `<a href="${topicUrl}&st=999">1000</a>`), 70);
    assert(page.previousOffset === 35, 'page size must be 35');
    assert(Math.max(...page.offsets) === 350, 'body link corrupted pagination');
    assert(parse('<p>Login or captcha</p>').error, 'challenge accepted as empty page');
  });
  const pages = {
    0: {offset: 0, offsets: [0, 35, 105], previousOffset: null, topicTitle: 'Fixture', posts: [{postId: '10'}, {postId: '11'}]},
    35: {offset: 35, offsets: [0, 35, 70, 105], previousOffset: 0, posts: [{postId: '10'}, {postId: '12'}, {postId: '13'}]},
    70: {offset: 70, offsets: [0, 35, 70, 105], previousOffset: 35, posts: [{postId: '10'}, {postId: '14'}, {postId: '15'}]},
    105: {offset: 105, offsets: [0, 70, 105], previousOffset: 70, posts: [{postId: '10'}, {postId: '16'}, {postId: '15'}]}
  };
  await test('Baseline starts at latest without importing', async () => {
    const calls = [];
    const result = await crawlTopic(async offset => { calls.push(offset); return pages[offset]; }, null);
    assert(result.lastPostId === '16' && !result.posts.length, 'baseline');
    assert(result.firstPostId === '10' && calls.join() === '0,105', 'baseline navigation');
  });
  await test('Backward multi-page crawl, deduplication and numeric order', async () => {
    const calls = [];
    const result = await crawlTopic(async offset => { calls.push(offset); return pages[offset]; }, '12');
    assert(result.posts.map(p => p.postId).join() === '13,14,15,16', 'missing posts or pinned header');
    assert(calls.join() === '0,105,70,35', 'header prematurely stopped crawl');
    const empty = await crawlTopic(async offset => pages[offset], '16');
    assert(!empty.posts.length && empty.lastPostId === '16', 'repeat check');
  });
  await test('Repeated header never stops backward crawl; an old ordinary post does', async () => {
    const marker = '145055810';
    const header = {postId: '85632963'};
    const mnpPages = {
      0: {offset: 0, offsets: [0, 20, 40], previousOffset: null, topicTitle: 'MNP',
        posts: [header, {postId: '84655351'}]},
      20: {offset: 20, offsets: [0, 20, 40], previousOffset: 0,
        posts: [header, {postId: marker}, {postId: '145060000'}]},
      40: {offset: 40, offsets: [0, 20, 40], previousOffset: 20,
        posts: [header, {postId: '145068300'}, {postId: '145068360'}]}
    };
    const calls = [];
    const result = await crawlTopic(async offset => { calls.push(offset); return mnpPages[offset]; },
      marker, false, '84655351');
    assert(calls.join() === '0,40,20', 'repeated header stopped crawl or old ordinary post did not');
    assert(result.posts.map(p => p.postId).join() === '145060000,145068300,145068360',
      'header was saved or new ordinary posts were lost');
  });
  await test('Interrupted navigation rejects; retry includes every post', async () => {
    let failed = false;
    try { await crawlTopic(async offset => { if (offset === 70) throw new Error('offline'); return pages[offset]; }, '12'); }
    catch { failed = true; }
    assert(failed, 'partial success');
    const retry = await crawlTopic(async offset => pages[offset], '12');
    assert(retry.posts.length === 4, 'retry lost posts');
    failed = false;
    try { await crawlTopic(async offset => ({...pages[offset], previousOffset: null}), '12'); }
    catch { failed = true; }
    assert(failed, 'ambiguous pagination accepted');
  });
  await test('Native IndexedDB atomic abort, existing posts retry, history preservation', async () => {
    // This test database belongs to the test page, not chrome-extension://.
    assert(location.protocol !== 'chrome-extension:', 'Do not run tests in extension origin');
    const topic = {topicId: 'test', lastPostId: '12', revision: 'old'};
    await dbPut('topics', topic);
    await dbPut('posts', {postId: '13', topicId: 'test', text: 'partial old attempt'});
    await dbPut('batches', {batchId: 'old', topicId: 'test', postIds: ['13']});
    const next = {...topic, lastPostId: '16', revision: 'new'};
    let failed = false;
    try {
      await commitCollection(topic, next, [{postId: '13', text: 'overwrite'}, {postId: '14'}], {topicId: 'test'});
    } catch { failed = true; }
    assert(failed, 'invalid batch did not abort');
    assert((await dbGet('topics', 'test')).lastPostId === '12', 'marker advanced on abort');
    assert(!(await dbGet('posts', '14')), 'post survived aborted transaction');
    assert((await dbGet('posts', '13')).text === 'partial old attempt', 'overwrite survived abort');
    await commitCollection(topic, next, [{postId: '13', text: 'complete'}, {postId: '14'}], {batchId: 'new', topicId: 'test', postIds: ['13', '14']});
    assert((await dbGet('topics', 'test')).lastPostId === '16', 'marker not committed');
    assert((await dbGet('batches', 'new')).postIds.includes('13'), 'pre-existing post lost from batch');
    assert(await dbGet('batches', 'old'), 'history removed');
    failed = false;
    try { await commitCollection(topic, {...next, lastPostId: '99'}, [], null); } catch { failed = true; }
    assert(failed && (await dbGet('topics', 'test')).lastPostId === '16', 'stale run overwrote marker');
  });
  await test('Backup validates, replaces all stores and rolls back failed writes', async () => {
    await dbPut('topics', {topicId: 'ordered', url: `${topicUrl}&backup=1`, lastPostId: '30',
      lastCheckedPostId: '31', sortOrder: 4, custom: 'kept'});
    await dbPut('posts', {postId: '30', topicId: 'ordered', text: 'complete record', custom: 7});
    await dbPut('batches', {batchId: 'reviewed', topicId: 'ordered', createdAt: '2026-09-13T10:00:00Z',
      postIds: ['30'], reviewed: true, custom: {kept: true}});
    const exported = await createBackup();
    assert(exported.format === BACKUP_FORMAT && exported.backupVersion === BACKUP_VERSION, 'backup signature');
    assert(Array.isArray(exported.data.topics) && Array.isArray(exported.data.posts) && Array.isArray(exported.data.batches), 'stores missing');
    assert(exported.data.topics.find(topic => topic.topicId === 'ordered').lastCheckedPostId === '31', 'topic fields lost');
    assert(exported.data.batches.find(batch => batch.batchId === 'reviewed').reviewed === true, 'batch fields lost');
    assert(!('job' in exported) && !('status' in exported), 'temporary status exported');

    const state = async () => JSON.stringify({
      topics: await dbGetAll('topics'), posts: await dbGetAll('posts'), batches: await dbGetAll('batches')
    });
    const unchanged = await state();
    const invalidBackups = [
      '{broken',
      {...exported, format: 'some-json'},
      {...exported, backupVersion: 999},
      {...exported, data: {...exported.data, topics: [{title: 'missing keys'}]}}
    ];
    for (const candidate of invalidBackups) {
      let failed = false;
      try { await restoreBackup(typeof candidate === 'string' ? JSON.parse(candidate) : candidate); } catch { failed = true; }
      assert(failed && await state() === unchanged, 'invalid backup changed data');
    }

    const replacement = {
      format: BACKUP_FORMAT,
      backupVersion: BACKUP_VERSION,
      exportedAt: '2026-09-13T12:00:00.000Z',
      data: {
        topics: [
          {topicId: 'legacy', url: `${topicUrl}&legacy=1`, lastPostId: '40'},
          {topicId: 'restored', url: `${topicUrl}&restored=1`, lastPostId: '50', lastCheckedPostId: '51', sortOrder: 0}
        ],
        posts: [{postId: '50', topicId: 'restored', text: 'restored'}],
        batches: [
          {batchId: 'legacy-batch', topicId: 'legacy', createdAt: '2026-09-12T10:00:00Z', postIds: []},
          {batchId: 'restored-batch', topicId: 'restored', createdAt: '2026-09-13T10:00:00Z', postIds: ['50'], reviewed: true}
        ]
      }
    };
    await restoreBackup(replacement);
    assert((await dbGetAll('topics')).length === 2 && !(await dbGet('topics', 'test')), 'restore merged topics');
    assert((await dbGetAll('posts')).length === 1 && !(await dbGet('posts', '30')), 'restore merged posts');
    assert((await dbGetAll('batches')).length === 2 && !(await dbGet('batches', 'reviewed')), 'restore merged batches');
    assert(!('sortOrder' in await dbGet('topics', 'legacy')) && !('reviewed' in await dbGet('batches', 'legacy-batch')), 'legacy fields invented');
    assert((await dbGet('topics', 'restored')).lastCheckedPostId === '51' && (await dbGet('batches', 'restored-batch')).reviewed, 'state not restored');

    const beforeWriteFailure = await state();
    const poisonedPost = {postId: 'poisoned', topicId: 'restored'};
    Object.defineProperty(poisonedPost, 'text', {enumerable: true, get() { throw new Error('write failure'); }});
    const poisoned = {...replacement, data: {...replacement.data, posts: [poisonedPost]}};
    let writeFailed = false;
    try { await restoreBackup(poisoned); } catch { writeFailed = true; }
    assert(writeFailed && await state() === beforeWriteFailure, 'failed write left partial restore');
  });
  await test('Markdown reads new datetimeText and legacy datetime', () => {
    const md = buildMarkdown({createdAt: '2026-09-12T12:00:00Z'}, {topicId: '1', url: topicUrl}, [
      {postId: '21', datetimeText: 'Сегодня, 13:31', text: '[ЦИТАТА ИЗ ПОСТА #10, АВТОР alice, УБРАНА]',
        replyTo: {postId: '10', author: 'alice'}, replyToList: [{postId: '10', author: 'alice'}, {author: 'bob'}]},
      {postId: '22', datetime: '01.08.25, 09:41'}]);
    assert(md.includes('**Время:** Сегодня, 13:31') && md.includes('**Время:** 01.08.25, 09:41'), 'date compatibility');
    assert(md.includes('**Ответ на:** пост #10, alice') && md.includes('**Ответ на:** автора bob'), 'reply list export');
    assert(md.includes('[ЦИТАТА ИЗ ПОСТА #10, АВТОР alice, УБРАНА]'), 'quote marker export');
  });
  output.textContent += `\nDONE: ${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`;
})();
