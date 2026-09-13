function replaceCards(container, cards, emptyText) {
  if (cards.length) {
    container.replaceChildren(...cards);
    return;
  }
  const empty = document.createElement("p");
  empty.className = "muted";
  empty.textContent = emptyText;
  container.replaceChildren(empty);
}
