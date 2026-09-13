function collect4pdaCurrentPage(doc = document, pageHref = location.href) {
  try {
    const pageUrl = new URL(pageHref);
    const topicId = pageUrl.searchParams.get("showtopic") || "";

    function normalizeTopicTitle(value) {
      return (value || "")
        .replace(/\s+/g, " ")
        .replace(/\s*[—–-]\s*4PDA(?:\s*Forum)?\s*$/i, "")
        .replace(/\s*\(Пост\s+.+?#\d+\)\s*$/i, "")
        .trim();
    }

    function isUsableTopicTitle(value) {
      if (!value || value.length < 2 || value.length > 300) return false;
      if (/^\[[^\]]+\]\s*Помощник$/i.test(value)) return false;
      if (/^(?:4PDA|Форум|Помощник|Вход|Авторизация)$/i.test(value)) return false;
      return !/^\[[XХ]\]/i.test(value);
    }

    function extractTopicTitle() {
      const candidates = [
        doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
        doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content"),
        doc.querySelector("[data-topic-title]")?.getAttribute("data-topic-title"),
        doc.querySelector("#topic-title, .topic-title, .topic_title")?.textContent,
        doc.querySelector("h1.maintitle, .maintitle h1")?.textContent,
        doc.title,
        doc.querySelector(".maintitle")?.textContent,
        doc.querySelector("main h1, #content h1")?.textContent
      ];
      for (const candidate of candidates) {
        const title = normalizeTopicTitle(candidate);
        if (isUsableTopicTitle(title)) return title;
      }
      return "";
    }

    const topicTitle = extractTopicTitle();

    const postEls = [...doc.querySelectorAll('div[id^="post-"]')]
      .filter(el => /^post-\d+$/.test(el.id));

    function explicitPostReference(scope, includeLinks = true) {
      if (!scope) return null;
      for (const name of ['data-post-id', 'data-post_id', 'data-post', 'post_id', 'post-id', 'post']) {
        const id = scope.getAttribute?.(name);
        if (/^\d+$/.test(id || '')) return {postId: id};
      }
      if (!includeLinks) return null;
      const links = scope.matches?.('a[href]') ? [scope] : [...scope.querySelectorAll('a[href]')];
      for (const a of links) {
        const u = new URL(a.href, pageHref);
        const id = u.searchParams.get('post_id') || u.searchParams.get('post') ||
          u.searchParams.get('pid') || u.searchParams.get('p');
        const fragmentId = u.hash.match(/^#(?:entry|post-?)(\d+)$/i)?.[1];
        const isFindPost = u.searchParams.get('act') === 'findpost' || u.searchParams.get('view') === 'findpost';
        if (['4pda.to', '4pda.ru'].includes(u.hostname) &&
            ((isFindPost && /^\d+$/.test(id || '')) || /^\d+$/.test(fragmentId || ''))) {
          return {postId: isFindPost ? id : fragmentId, url: a.href};
        }
      }
      return null;
    }

    function explicitQuoteAuthor(container, header) {
      for (const scope of [header, container]) {
        if (!scope) continue;
        for (const name of ['data-author', 'data-username', 'author']) {
          const author = (scope.getAttribute?.(name) || '').replace(/\s+/g, ' ').trim();
          if (author) return author;
        }
      }
      if (!header) return '';
      const marked = header.querySelector(
        '.quote-author, .quote_author, [data-author], [data-username], a[href*="showuser="], b, strong'
      );
      const markedText = (marked?.getAttribute?.('data-author') || marked?.getAttribute?.('data-username') ||
        marked?.textContent || '').replace(/\s+/g, ' ').trim();
      if (markedText) return markedText;
      const text = (header.textContent || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/^\s*(?:Цитата\s*[:(]?\s*)?([^@,()]{1,80}?)\s*@\s*(?:\d|Сегодня|Вчера)/i);
      return match?.[1].trim() || '';
    }

    function topLevelQuotes(root) {
      const quoteSelector = '.quote, blockquote, .quotemain';
      return [...root.querySelectorAll(quoteSelector)]
        .filter(container => !container.parentElement?.closest(quoteSelector))
        .map(container => {
          const previous = container.previousElementSibling;
          const header = previous?.matches('.quotetop, .quote-title, .quote_title, .block-title') ? previous :
            container.querySelector(':scope > .quotetop, :scope > .quote-title, :scope > .quote_title, :scope > .block-title, :scope > header, :scope > cite');
          return {container, header};
        });
    }

    function quoteMetadata(container, header) {
      // Links are trusted only in the quote header. On the container itself only
      // explicit post attributes are allowed, so links in quoted prose cannot match.
      const reference = explicitPostReference(header) || explicitPostReference(container, false);
      const author = explicitQuoteAuthor(container, header);
      if (!reference?.postId && !author) return null;
      return {...(reference || {}), author};
    }

    const SERVICE_FINDPOST_GIF = '/s/mQ60RwKIZz1PFQxMexb5gSBJeDUF9SO5wjSGuib1UEdTaYz1Tsyi.gif';

    function isKnownServiceFindPostButton(link) {
      if (!explicitPostReference(link)?.postId) return false;
      return [...link.querySelectorAll('img')].some(img => {
        const src = absoluteHttpUrl(img.getAttribute('src'));
        if (!src || img.getAttribute('alt')?.trim() !== '*') return false;
        const url = new URL(src);
        return ['4pda.to', '4pda.ru'].includes(url.hostname) && url.pathname === SERVICE_FINDPOST_GIF;
      });
    }

    function serviceReplyPrefixes(postEl, allowedPostIds = null) {
      const prefixes = [];
      for (const first of postEl.querySelectorAll('a[href]')) {
        if (first.closest('.quote, blockquote, .quotemain, .quotetop')) continue;
        const meta = explicitPostReference(first);
        if (!meta?.postId || (allowedPostIds && !allowedPostIds.has(meta.postId))) continue;
        const knownButton = isKnownServiceFindPostButton(first);
        if (!knownButton && (first.textContent || '').trim()) continue;
        let scope = first.parentElement;
        let matched = false;
        for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
          const beforeRange = doc.createRange();
          beforeRange.selectNodeContents(scope);
          beforeRange.setEndBefore(first);
          if (beforeRange.toString().trim()) break;

          // The permalink has no text, so after the leading-content check the
          // container's textContent is exactly the visible text following it.
          // This also works when the link itself is nested in an empty span.
          const after = (scope.textContent || '').replace(/\u00a0/g, ' ');
          const author = after.match(/^\s*([^,\n]{1,80}?)\s*,/)?.[1].replace(/\s+/g, ' ').trim();
          if (author) {
            // The link may live in its own inline wrapper while "nickname,"
            // is a sibling of that wrapper. The enclosing scope must still
            // begin with the empty permalink, which excludes content links.
            prefixes.push({link: first, meta: {...meta, author}, knownButton});
            matched = true;
            break;
          }
          if (scope === postEl) break;
        }
        if (knownButton && !matched) prefixes.push({link: first, meta, knownButton: true});
      }
      return prefixes;
    }

    function deduplicateReplies(replies) {
      const result = [];
      const byPostId = new Map();
      for (const reply of replies) {
        if (!reply.postId) {
          result.push(reply);
          continue;
        }
        const existing = byPostId.get(reply.postId);
        if (!existing) {
          const copy = {...reply};
          byPostId.set(reply.postId, copy);
          result.push(copy);
          continue;
        }
        if (!existing.author && reply.author) existing.author = reply.author;
        if (!existing.url && reply.url) existing.url = reply.url;
      }
      return result;
    }

    function attachmentIdentity(value) {
      const url = absoluteHttpUrl(value);
      if (!url) return '';
      const match = new URL(url).pathname.match(/\/forum\/dl\/post\/(\d+)(?:\/|$)/i);
      return match ? `attachment:${match[1]}` : '';
    }

    function collectAttachments(postEl, inlineAttachmentIds = new Set()) {
      const out = [];
      const seen = new Set();

      postEl.querySelectorAll('a[href*="/forum/dl/post/"]').forEach(a => {
        const url = a.href;
        const identity = attachmentIdentity(url);
        if (identity && inlineAttachmentIds.has(identity)) return;
        if (seen.has(url)) return;
        seen.add(url);
        let label = (a.innerText || a.textContent || "").trim();
        if (!label || /^https?:\/\//i.test(label)) {
          label = url.split("/").pop() || "вложение";
          try { label = decodeURIComponent(label); } catch { /* Keep malformed URL label. */ }
        }
        out.push({url, label});
      });

      return out;
    }

    function quoteMarker(meta) {
      if (meta?.postId && meta.author) return `[ЦИТАТА ИЗ ПОСТА #${meta.postId}, АВТОР ${meta.author}, УБРАНА]`;
      if (meta?.postId) return `[ЦИТАТА ИЗ ПОСТА #${meta.postId} УБРАНА]`;
      if (meta?.author) return `[ЦИТАТА АВТОРА ${meta.author} УБРАНА]`;
      return '[ЦИТАТА УБРАНА]';
    }

    function absoluteHttpUrl(value) {
      if (!value) return '';
      try {
        const url = new URL(value, pageHref);
        return /^https?:$/.test(url.protocol) ? url.href : '';
      } catch {
        return '';
      }
    }

    function isFullSizeImageLink(value) {
      const url = absoluteHttpUrl(value);
      if (!url) return '';
      try {
        const pathname = new URL(url).pathname;
        return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(pathname) || /\/forum\/dl\/post\//i.test(pathname) ? url : '';
      } catch {
        return '';
      }
    }

    function isServiceImage(img, src) {
      const classText = `${img.className || ''} ${img.parentElement?.className || ''}`;
      const alt = (img.getAttribute('alt') || '').trim();
      const link = img.closest('a[href]');
      const postReference = link && explicitPostReference(link);
      // 4PDA renders reply/findpost controls as tiny images whose alt is only a
      // symbol (often "*"). The findpost link is the decisive DOM signal; alt
      // alone never removes an image.
      if (/^[*#>»›→↗•·]+$/.test(alt) && postReference?.postId) return true;
      if (/\b(?:avatar|emoticon|emoji|smil(?:e|ey|ie)|reputation|rep-icon|rank|button|ui-icon|quote-icon)\b/i.test(classText)) return true;
      if (img.hasAttribute('data-emoticon') || img.getAttribute('role') === 'presentation' || img.getAttribute('aria-hidden') === 'true') return true;
      if (img.closest('.avatar, .userphoto, .postdetails, .signature, .quotetop, .quote-title, .quote_title, .block-title, .post-buttons, .reputation, .rank')) return true;
      if (/\/(?:style_images|style_emoticons|emoticons|smil(?:e|ey|ies)|emoji|ranks?|reputation|skins?|themes?)\//i.test(src)) return true;
      return /(?:^|[/_.-])(?:icon|button|spacer|blank|pixel|bullet)(?:[/_.-]|$)/i.test(new URL(src).pathname);
    }

    function spoilerTitle(img) {
      const spoiler = img.closest('.spoil, .spoiler, .block-spoiler, [data-spoiler]');
      if (!spoiler) return '';
      const title = spoiler.querySelector(':scope > .spoilertop, :scope > .spoiler-title, :scope > .block-title, :scope > summary');
      return (title?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function imageAlt(img) {
      const alt = (img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      if (alt && !/^(?:image|img|picture|photo|thumbnail|изображение|картинка|фото|смайл(?:ик)?|emoji|icon)$/i.test(alt) &&
          !/^[:;=8xX][-^']?[)(/\\DPpOo]+$/.test(alt) && !/^[*#>»›→↗•·]+$/.test(alt)) return alt;
      return spoilerTitle(img) || 'изображение';
    }

    function markdownImage(alt, url) {
      const safeAlt = alt.replace(/[\[\]\\]/g, '\\$&');
      const safeUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      return `\n![${safeAlt}](${safeUrl})\n`;
    }

    function nearbyAttachmentOriginal(img, src, root) {
      const ownLink = img.closest('a[href]');
      const ownOriginal = ownLink ? isFullSizeImageLink(ownLink.getAttribute('href')) : '';
      if (ownOriginal) return {url: ownOriginal, altImage: img};
      if (!/\bimg-resized(?:\.[a-z0-9]+)?$/i.test(new URL(src).pathname.split('/').pop() || '')) return null;
      let scope = img.parentElement;
      for (let depth = 0; scope && scope !== root && depth < 3; depth += 1, scope = scope.parentElement) {
        const originals = [...scope.querySelectorAll('a[href*="/forum/dl/post/"]')]
          .map(a => ({url: isFullSizeImageLink(a.getAttribute('href')), altImage: a.querySelector('img')}))
          .filter(item => item.url);
        const unique = [...new Map(originals.map(item => [item.url, item])).values()];
        if (unique.length === 1) return unique[0];
        if (unique.length > 1) return null;
      }
      return null;
    }

    function cleanPostText(postEl, replyToList) {
      const clone = postEl.cloneNode(true);
      const inlineAttachmentIds = new Set();

      clone.querySelectorAll(
        "script, style, noscript, form, input, button, select, textarea, .signature, .post-edit-reason, .post-edit-info, .post-edit, .edit"
      ).forEach(el => el.remove());

      // Process only outer quotes: nested quotes disappear with their outer body.
      topLevelQuotes(clone).forEach(({container, header}) => {
        const meta = quoteMetadata(container, header);
        container.replaceWith(doc.createTextNode(`\n${quoteMarker(meta)}\n`));
        if (header && header !== container && clone.contains(header)) header.remove();
      });

      // Удаляем соседние заголовки цитат, если остались.
      clone.querySelectorAll(".quotetop").forEach(el => el.remove());

      // Remove only the empty service permalink of a structurally recognized
      // reply prefix, and only when its ID is already confirmed in replyToList.
      const replyIds = new Set(replyToList.map(reply => reply.postId).filter(Boolean));
      for (const {link} of serviceReplyPrefixes(clone, replyIds)) link.remove();
      // This exact 4PDA control is never content, even when surrounding markup
      // is insufficient to recognize the full reply prefix.
      for (const link of [...clone.querySelectorAll('a[href]')]) {
        if (isKnownServiceFindPostButton(link)) link.remove();
      }

      // Turn content images into Markdown while they still occupy their exact DOM
      // position. Quotes and reply icons have already been removed above.
      for (const img of [...clone.querySelectorAll('img')]) {
        if (!clone.contains(img)) continue;
        const src = absoluteHttpUrl(
          img.getAttribute('data-original') || img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src') || img.getAttribute('src')
        );
        if (!src || isServiceImage(img, src)) {
          img.remove();
          continue;
        }
        const link = img.closest('a[href]');
        const original = nearbyAttachmentOriginal(img, src, clone);
        const imageUrl = original?.url || src;
        const identity = attachmentIdentity(imageUrl);
        if (identity && inlineAttachmentIds.has(identity)) {
          if (link && link.querySelectorAll('img').length === 1 && !(link.textContent || '').trim()) link.remove();
          else img.remove();
          continue;
        }
        if (identity) inlineAttachmentIds.add(identity);
        const marker = doc.createTextNode(markdownImage(imageAlt(original?.altImage || img), imageUrl));
        if (link && link.querySelectorAll('img').length === 1 && !(link.textContent || '').trim()) link.replaceWith(marker);
        else img.replaceWith(marker);
      }

      // Вложения: сами ссылки оставим в отдельном блоке Markdown,
      // из текста убираем технические подписи.
      clone.querySelectorAll('a[href*="/forum/dl/post/"]').forEach(a => {
        const parentText = (a.parentElement?.innerText || "").trim();
        if (/оригинала|КБ|МБ|прикреплен/i.test(parentText)) {
          const parent = a.parentElement;
          if (parent && parent !== clone) parent.remove();
          else a.remove();
        } else {
          a.remove();
        }
      });

      // Чистим технические строки картинок/вложений.
      const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const kill = [];
      while (walker.nextNode()) {
        const t = walker.currentNode;
        const s = t.nodeValue.trim();
        if (
          /^\d+%\s+оригинала$/i.test(s) ||
          /^\d+\s*x\s*\d+\s*\([\d.,]+\s*(КБ|МБ)\)$/i.test(s) ||
          /^#?\s*Прикрепленные (изображения|файлы)$/i.test(s)
        ) kill.push(t);
      }
      kill.forEach(t => t.nodeValue = "");

      clone.querySelectorAll("a[href]").forEach(a => {
        const href = a.href;
        const txt = (a.innerText || a.textContent || "").trim();
        if (!txt) a.replaceWith(doc.createTextNode(href));
        else if (txt === href) a.replaceWith(doc.createTextNode(href));
        else a.replaceWith(doc.createTextNode(`${txt} (${href})`));
      });

      clone.querySelectorAll("br").forEach(el => el.replaceWith(doc.createTextNode("\n")));
      clone.querySelectorAll("div, p, li, pre").forEach(el => el.appendChild(doc.createTextNode("\n")));
      const text = (clone.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^#\s+/gm, "")
        .trim();
      return {text, inlineAttachmentIds};
    }

    const posts = [];

    for (const postEl of postEls) {
      const postId = postEl.id.replace("post-", "");

      const postMain =
        doc.getElementById(`post-main-${postId}`) ||
        postEl.closest("td.post2") ||
        postEl.parentElement;

      const postTable =
        postEl.closest("table.ipbtable") ||
        postMain?.closest("table.ipbtable") ||
        postMain?.parentElement;

      let author = "";
      const authorSelectors = [
        ".normalname",
        ".postdetails a[href*='showuser=']",
        "a[href*='showuser=']"
      ];
      for (const sel of authorSelectors) {
        const found = postTable?.querySelector(sel);
        if (!found) continue;
        const txt = (found.innerText || found.textContent || "").trim();
        if (txt) {
          author = txt.split("\n")[0].trim();
          break;
        }
      }

      let datetime = "";
      const candidates = postTable ? postTable.querySelectorAll(".postdetails, .post_date, .row2") : [];
      // JavaScript \b is ASCII-only and does not match the start of «Сегодня».
      const dateRegex = /(?:сегодня|вчера|\d{1,2}\.\d{1,2}\.\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?/i;
      for (const el of candidates) {
        if (postEl.contains(el)) continue;
        const header = el.cloneNode(true);
        header.querySelectorAll('div[id^="post-"], .signature, .postcolor').forEach(body => body.remove());
        const m = (header.textContent || "").replace(/\s+/g, " ").match(dateRegex);
        if (m) { datetime = m[0]; break; }
      }
      // Forum timezone may differ from the browser; do not invent an ISO offset.
      const timeEl = [...(postTable?.querySelectorAll('time[datetime]') || [])].find(el => !postEl.contains(el));
      const explicit = timeEl?.getAttribute('datetime') || "";
      const datetimeIso = /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(explicit) && !Number.isNaN(Date.parse(explicit))
        ? new Date(explicit).toISOString() : null;

      const directUrl = `${pageUrl.origin}/forum/index.php?showtopic=${encodeURIComponent(topicId)}&view=findpost&p=${encodeURIComponent(postId)}`;

      const extractedReplies = topLevelQuotes(postEl)
        .map(({container, header}) => quoteMetadata(container, header))
        .filter(Boolean);
      const prefixCandidates = serviceReplyPrefixes(postEl);
      if (!extractedReplies.length) {
        if (prefixCandidates[0]) extractedReplies.push(prefixCandidates[0].meta);
      } else {
        for (const prefix of prefixCandidates) {
          if (prefix.knownButton) extractedReplies.push(prefix.meta);
        }
      }
      const replyToList = deduplicateReplies(extractedReplies);

      const cleaned = cleanPostText(postEl, replyToList);

      posts.push({
        postId,
        author,
        datetimeText: datetime,
        datetimeIso,
        url: directUrl,
        replyTo: replyToList[0] || null,
        replyToList,
        attachments: collectAttachments(postEl, cleaned.inlineAttachmentIds),
        text: cleaned.text
      });
    }

    const offset = Number(pageUrl.searchParams.get("st") || 0);
    const offsets = new Set([offset]);
    const numbered = [];
    let explicitPrevious = null;
    // Ignore links inside posts, including links to other pages of this topic.
    for (const a of doc.querySelectorAll('a[href]')) {
      if (a.closest('div[id^="post-"], .postcolor, .signature')) continue;
      const u = new URL(a.href, pageHref);
      if (u.origin !== pageUrl.origin || u.pathname !== pageUrl.pathname ||
          u.searchParams.get("showtopic") !== topicId || u.searchParams.has("view") ||
          u.searchParams.has("p") || u.searchParams.has("pid")) continue;
      const st = u.searchParams.get("st") || "0";
      if (/^\d+$/.test(st) && Number.isSafeInteger(Number(st))) {
        offsets.add(Number(st));
        const label = (a.textContent || '').trim();
        if (/^\d+$/.test(label)) numbered.push({number: Number(label), offset: Number(st)});
        if (a.rel === 'prev' || /^(?:[<«‹]+|Назад|Предыдущая)$/i.test(label)) explicitPrevious = Number(st);
      }
    }
    // Derive page size from numbered links (including sparse first/last links).
    // A missing adjacent link must never silently skip a range of messages.
    const sizes = new Set();
    for (const link of numbered) {
      if (link.number > 1) {
        const size = link.offset / (link.number - 1);
        if (Number.isSafeInteger(size) && size > 0) sizes.add(size);
      }
    }
    if (sizes.size > 1) throw new Error('Противоречивая пагинация: сбор остановлен.');
    const pageSize = [...sizes][0];
    const previousOffset = pageSize && offset >= pageSize ? offset - pageSize : explicitPrevious;
    if (!posts.length) throw new Error("Не найдены сообщения: проверьте вход в 4PDA, защиту сайта и разметку.");
    return {
      offset,
      previousOffset,
      offsets: [...offsets].sort((a, b) => a - b),
      topicId,
      topicTitle,
      topicUrl: pageHref,
      posts
    };
  } catch (e) {
    return {error: e?.message || String(e)};
  }
}
