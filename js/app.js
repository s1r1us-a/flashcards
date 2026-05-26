/* =============================================================================
 * Flashcards – UI logic
 * Depends on global `Store` (see js/store.js)
 * ========================================================================== */

(function () {
  "use strict";

  const SWATCHES = [
    "#8b5cf6", "#ec4899", "#3b82f6", "#10b981",
    "#f59e0b", "#ef4444", "#14b8a6", "#a855f7",
  ];

  const state = {
    view: "boxes",
    currentCategoryId: null,
    boxFilter: "",
    cardFilter: "",
    modal: { type: null, editingId: null, color: SWATCHES[0] },
    study: { deck: [], index: 0, correct: 0, wrong: 0, revealed: false },
  };

  /* ---------- DOM helpers ---------- */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ---------- View routing ---------- */
  function setView(name) {
    state.view = name;
    $$(".view").forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });
    renderCrumbs();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function renderCrumbs() {
    const el = $("#crumbs");
    if (state.view === "boxes") { el.innerHTML = ""; return; }
    const cat = state.currentCategoryId
      ? await Store.getCategory(state.currentCategoryId)
      : null;
    const parts = ["<span>Boxen</span>"];
    if (cat) parts.push(`<span>${escapeHtml(cat.name)}</span>`);
    if (state.view === "study") parts.push("<span>Lernen</span>");
    if (state.view === "finish") parts.push("<span>Ergebnis</span>");
    el.innerHTML = parts.join("");
  }

  /* ---------- Boxes view ---------- */
  async function renderBoxes() {
    const grid = $("#boxes-grid");
    const empty = $("#boxes-empty");
    const categories = await Store.getCategories();
    const filter = state.boxFilter.trim().toLowerCase();
    const filtered = filter
      ? categories.filter((c) => c.name.toLowerCase().includes(filter))
      : categories;

    if (categories.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const cards = await Store.getCards();
    const countByCat = cards.reduce((acc, c) => {
      acc[c.categoryId] = (acc[c.categoryId] || 0) + 1;
      return acc;
    }, {});

    const tiles = filtered.map((cat) => {
      const count = countByCat[cat.id] || 0;
      return `
        <div class="box-tile" data-id="${cat.id}" data-action="open-box"
             style="--tile-color: ${cat.color}">
          <button class="icon-btn" data-action="edit-box" data-id="${cat.id}"
                  aria-label="Box bearbeiten" title="Bearbeiten">✎</button>
          <div>
            <div class="box-tile-dot"></div>
            <div class="box-tile-name">${escapeHtml(cat.name)}</div>
          </div>
          <div class="box-tile-meta">${count} Karte${count === 1 ? "" : "n"}</div>
        </div>`;
    });

    tiles.push(`
      <div class="box-tile add" data-action="new-box">
        <div>
          <div class="plus">+</div>
          <div>Neue Box</div>
        </div>
      </div>`);

    grid.innerHTML = tiles.join("");
  }

  /* ---------- Cards view ---------- */
  async function renderCards() {
    const cat = await Store.getCategory(state.currentCategoryId);
    if (!cat) { setView("boxes"); renderBoxes(); return; }

    $("#box-title").textContent = cat.name;
    $("#box-title").style.color = "";

    const grid = $("#cards-grid");
    const empty = $("#cards-empty");
    const meta = $("#box-meta");
    const studyBtn = $('[data-action="study-start"]');

    const cards = await Store.getCards(cat.id);
    meta.textContent = `${cards.length} Karte${cards.length === 1 ? "" : "n"}`;
    studyBtn.disabled = cards.length === 0;
    studyBtn.style.opacity = cards.length === 0 ? "0.4" : "1";
    studyBtn.style.pointerEvents = cards.length === 0 ? "none" : "";

    if (cards.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }

    const filter = state.cardFilter.trim().toLowerCase();
    const filtered = filter
      ? cards.filter((c) =>
          c.front.toLowerCase().includes(filter) ||
          c.back.toLowerCase().includes(filter))
      : cards;

    empty.hidden = true;

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:40px">
        <div class="empty-icon">🔍</div>
        <p class="muted">Keine Karten entsprechen "${escapeHtml(state.cardFilter)}".</p>
      </div>`;
      return;
    }

    grid.innerHTML = filtered.map((card) => {
      const acc = card.progress.seen
        ? Math.round((card.progress.correct / card.progress.seen) * 100)
        : null;
      return `
        <div class="card-item" data-id="${card.id}">
          <div class="card-item-actions">
            <button class="icon-btn" data-action="edit-card" data-id="${card.id}"
                    aria-label="Karte bearbeiten" title="Bearbeiten">✎</button>
            <button class="icon-btn" data-action="delete-card" data-id="${card.id}"
                    aria-label="Karte löschen" title="Löschen">🗑</button>
          </div>
          <div>
            <div class="label">Vorderseite</div>
            <div class="text">${escapeHtml(card.front) || "<em style='color:var(--muted)'>leer</em>"}</div>
          </div>
          <div class="divider"></div>
          <div>
            <div class="label">Rückseite</div>
            <div class="text">${escapeHtml(card.back) || "<em style='color:var(--muted)'>leer</em>"}</div>
          </div>
          ${acc !== null ? `<div class="label" style="margin-top:auto">
            ${card.progress.seen}× geübt · ${acc}% richtig</div>` : ""}
        </div>`;
    }).join("");
  }

  /* ---------- Modals ---------- */
  function renderSwatches() {
    const el = $("#box-swatches");
    el.innerHTML = SWATCHES.map((c) => `
      <span class="swatch ${c === state.modal.color ? "selected" : ""}"
            data-color="${c}" style="background:${c}"></span>
    `).join("");
  }

  async function openBoxModal(editId) {
    state.modal.type = "box";
    state.modal.editingId = editId || null;
    state.modal.color = SWATCHES[0];

    let name = "";
    if (editId) {
      const cat = await Store.getCategory(editId);
      if (cat) { name = cat.name; state.modal.color = cat.color; }
      $("#modal-box-title").textContent = "Box bearbeiten";
    } else {
      $("#modal-box-title").textContent = "Neue Box";
    }

    $("#box-name").value = name;
    renderSwatches();
    $("#modal-box").hidden = false;
    setTimeout(() => $("#box-name").focus(), 50);
  }

  async function openCardModal(editId) {
    state.modal.type = "card";
    state.modal.editingId = editId || null;

    let front = "", back = "";
    if (editId) {
      const card = await Store.getCard(editId);
      if (card) { front = card.front; back = card.back; }
      $("#modal-card-title").textContent = "Karte bearbeiten";
    } else {
      $("#modal-card-title").textContent = "Neue Karte";
    }

    $("#card-front").value = front;
    $("#card-back").value = back;
    $("#modal-card").hidden = false;
    setTimeout(() => $("#card-front").focus(), 50);
  }

  function closeModals() {
    $("#modal-box").hidden = true;
    $("#modal-card").hidden = true;
    state.modal.type = null;
    state.modal.editingId = null;
  }

  async function saveBox() {
    const name = $("#box-name").value.trim();
    if (!name) { showToast("Bitte gib einen Namen ein"); return; }
    if (state.modal.editingId) {
      await Store.updateCategory(state.modal.editingId, { name, color: state.modal.color });
      showToast("Box aktualisiert");
    } else {
      await Store.addCategory(name, state.modal.color);
      showToast("Box erstellt");
    }
    closeModals();
    renderBoxes();
  }

  async function saveCard() {
    const front = $("#card-front").value.trim();
    const back  = $("#card-back").value.trim();
    if (!front && !back) { showToast("Bitte fülle mindestens eine Seite aus"); return; }
    if (state.modal.editingId) {
      await Store.updateCard(state.modal.editingId, { front, back });
      showToast("Karte aktualisiert");
    } else {
      await Store.addCard(state.currentCategoryId, front, back);
      showToast("Karte hinzugefügt");
    }
    closeModals();
    renderCards();
  }

  /* ---------- Study mode ---------- */
  async function startStudy() {
    const cards = await Store.getCards(state.currentCategoryId);
    if (cards.length === 0) { showToast("Keine Karten zum Lernen"); return; }
    state.study = {
      deck: shuffle(cards.slice()),
      index: 0,
      correct: 0,
      wrong: 0,
      revealed: false,
    };
    setView("study");
    renderStudy();
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function renderStudy() {
    const { deck, index, revealed } = state.study;
    const total = deck.length;
    const card  = deck[index];

    $("#study-front").textContent = card.front || "—";
    $("#study-back").textContent  = card.back  || "—";
    $("#study-count").textContent = `${index + 1} / ${total}`;
    $("#study-progress").style.width = `${(index / total) * 100}%`;

    const flip = $("#flipcard");
    flip.classList.toggle("flipped", revealed);

    const actions = $("#study-actions");
    actions.classList.toggle("revealed", revealed);
  }

  async function answerStudy(correct) {
    if (!state.study.revealed) return;
    const card = state.study.deck[state.study.index];
    await Store.recordAnswer(card.id, correct);
    if (correct) state.study.correct += 1;
    else state.study.wrong += 1;

    state.study.index += 1;
    state.study.revealed = false;

    if (state.study.index >= state.study.deck.length) {
      finishStudy();
    } else {
      renderStudy();
    }
  }

  function flipStudyCard() {
    if (state.view !== "study") return;
    state.study.revealed = !state.study.revealed;
    renderStudy();
  }

  function finishStudy() {
    const { correct, wrong, deck } = state.study;
    const total = deck.length;
    const pct = total ? Math.round((correct / total) * 100) : 0;
    $("#finish-stats").innerHTML = `
      <div class="stat">
        <div class="stat-value" style="color:var(--success)">${correct}</div>
        <div class="stat-label">Richtig</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color:var(--danger)">${wrong}</div>
        <div class="stat-label">Falsch</div>
      </div>
      <div class="stat">
        <div class="stat-value">${pct}%</div>
        <div class="stat-label">Quote</div>
      </div>`;
    setView("finish");
  }

  /* ---------- Actions / event delegation ---------- */
  async function handleClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;

    switch (action) {
      case "go-home":
        state.currentCategoryId = null;
        setView("boxes");
        renderBoxes();
        break;

      case "new-box":
        openBoxModal();
        break;

      case "edit-box":
        e.stopPropagation();
        openBoxModal(id);
        break;

      case "open-box":
        state.currentCategoryId = id;
        state.cardFilter = "";
        $("#search-cards").value = "";
        setView("cards");
        renderCards();
        break;

      case "delete-box":
        if (confirm("Diese Box und alle ihre Karten wirklich löschen?")) {
          await Store.deleteCategory(state.currentCategoryId);
          state.currentCategoryId = null;
          showToast("Box gelöscht");
          setView("boxes");
          renderBoxes();
        }
        break;

      case "new-card":
        openCardModal();
        break;

      case "edit-card":
        e.stopPropagation();
        openCardModal(id);
        break;

      case "delete-card":
        e.stopPropagation();
        if (confirm("Diese Karte wirklich löschen?")) {
          await Store.deleteCard(id);
          showToast("Karte gelöscht");
          renderCards();
        }
        break;

      case "close-modal":
        closeModals();
        break;

      case "save-box":
        saveBox();
        break;

      case "save-card":
        saveCard();
        break;

      case "study-start":
        startStudy();
        break;

      case "study-answer":
        answerStudy(target.dataset.correct === "true");
        break;

      case "study-exit":
        if (confirm("Lernen wirklich beenden?")) {
          setView("cards");
          renderCards();
        }
        break;

      case "study-again":
        startStudy();
        break;

      case "go-box":
        setView("cards");
        renderCards();
        break;
    }
  }

  function bindEvents() {
    document.addEventListener("click", handleClick);

    // Flipcard click & keyboard
    $("#flipcard").addEventListener("click", flipStudyCard);
    $("#flipcard").addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        flipStudyCard();
      }
    });

    // Swatch selection
    $("#box-swatches").addEventListener("click", (e) => {
      const sw = e.target.closest(".swatch");
      if (!sw) return;
      state.modal.color = sw.dataset.color;
      renderSwatches();
    });

    // Search inputs
    $("#search-boxes").addEventListener("input", (e) => {
      state.boxFilter = e.target.value;
      renderBoxes();
    });
    $("#search-cards").addEventListener("input", (e) => {
      state.cardFilter = e.target.value;
      renderCards();
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#modal-box").hidden || !$("#modal-card").hidden) closeModals();
      }
      if (state.view === "study" && state.study.revealed) {
        if (e.key === "ArrowLeft" || e.key === "1") answerStudy(false);
        if (e.key === "ArrowRight" || e.key === "2") answerStudy(true);
      }
    });

    // Modal enter to save
    $("#box-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBox();
    });
  }

  /* ---------- Boot ---------- */
  function init() {
    bindEvents();
    setView("boxes");
    renderBoxes();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
