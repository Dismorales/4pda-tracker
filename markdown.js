function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "4pda-posts";
}

function buildMarkdown(batch, topic, posts) {
  const lines = [];
  lines.push(`# ${topic.title || "Тема 4PDA"}`);
  lines.push("");
  lines.push(`Источник: ${topic.url}`);
  lines.push(`Topic ID: ${topic.topicId}`);
  lines.push(`Собрано: ${new Date(batch.createdAt).toLocaleString("ru-RU")}`);
  lines.push(`Новых постов: **${posts.length}**`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const post of posts) {
    lines.push(`## Пост #${post.postId}`);
    if (post.author) lines.push(`**Автор:** ${post.author}`);
    if (post.datetimeText || post.datetime) lines.push(`**Время:** ${post.datetimeText || post.datetime}`);
    if (post.url) lines.push(`**Ссылка:** ${post.url}`);
    const sourceReplies = post.replyToList?.length ? post.replyToList : (post.replyTo ? [post.replyTo] : []);
    const replies = [];
    const repliesByPostId = new Map();
    for (const reply of sourceReplies) {
      if (!reply.postId) {
        replies.push(reply);
        continue;
      }
      const existing = repliesByPostId.get(reply.postId);
      if (!existing) {
        const copy = {...reply};
        repliesByPostId.set(reply.postId, copy);
        replies.push(copy);
      } else if (!existing.author && reply.author) {
        existing.author = reply.author;
      }
    }
    for (const reply of replies) {
      if (reply.postId) {
        const who = reply.author ? `, ${reply.author}` : "";
        lines.push(`**Ответ на:** пост #${reply.postId}${who}`);
      } else if (reply.author) {
        lines.push(`**Ответ на:** автора ${reply.author}`);
      }
    }
    lines.push("");
    lines.push(post.text || "_Пустой пост_");

    if (post.attachments?.length) {
      lines.push("");
      lines.push("**Вложения:**");
      for (const a of post.attachments) {
        lines.push(`- ${a.label || "вложение"}: ${a.url}`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
