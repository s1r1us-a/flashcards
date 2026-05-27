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
    view: "auth",
    authMode: "login",
    currentCategoryId: null,
    boxFilter: "",
    cardFilter: "",
    shopFilter: "",
    modal: { type: null, editingId: null, color: SWATCHES[0] },
    study: { deck: [], index: 0, correct: 0, wrong: 0, revealed: false },
  };

  /* ---------- DOM helpers ---------- */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? "" : s)
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

  function formatDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString("de-DE", {
      day: "2-digit", month: "long", year: "numeric",
    });
  }

  function authorName(uid) {
    const u = Store.getUser(uid);
    return (u && u.displayName) || "Unbekannt";
  }

  /* ---------- View routing ---------- */
  function setView(name) {
    state.view = name;
    $$(".view").forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });
    updateNav();
    renderCrumbs();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateNav() {
    const user = Store.getCurrentUser();
    const nav = $("#main-nav");
    const userArea = $("#user-area");
    if (!user) {
      nav.hidden = true;
      userArea.hidden = true;
      return;
    }
    nav.hidden = false;
    userArea.hidden = false;
    $("#user-name").textContent = user.displayName;
    const mapping = { boxes: "goto-boxes", shop: "goto-shop", profile: "goto-profile" };
    const active = mapping[state.view];
    $$(".nav-tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.action === active);
    });
  }

  async function renderCrumbs() {
    const el = $("#crumbs");
    if (!Store.getCurrentUser()) { el.innerHTML = ""; return; }
    if (state.view === "boxes" || state.view === "shop" || state.view === "profile" || state.view === "auth") {
      el.innerHTML = "";
      return;
    }
    const cat = state.currentCategoryId
      ? await Store.getCategory(state.currentCategoryId)
      : null;
    const parts = ["<span>Bibliothek</span>"];
    if (cat) parts.push(`<span>${escapeHtml(cat.name)}</span>`);
    if (state.view === "study") parts.push("<span>Lernen</span>");
    if (state.view === "finish") parts.push("<span>Ergebnis</span>");
    el.innerHTML = parts.join("");
  }

  /* ---------- Auth view ---------- */
  function renderAuth() {
    const isRegister = state.authMode === "register";
    $$(".auth-tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.mode === state.authMode);
    });
    $("#auth-name-field").hidden = !isRegister;
    $("#auth-submit-btn").textContent = isRegister ? "Konto erstellen" : "Anmelden";
    $("#auth-password").autocomplete = isRegister ? "new-password" : "current-password";
    $("#auth-error").hidden = true;
  }

  async function submitAuth() {
    const email = $("#auth-email").value.trim();
    const pw    = $("#auth-password").value;
    const name  = $("#auth-name").value.trim();
    const errEl = $("#auth-error");
    errEl.hidden = true;

    if (!email || !pw) {
      errEl.textContent = "Bitte E-Mail und Passwort eingeben.";
      errEl.hidden = false;
      return;
    }
    if (state.authMode === "register" && pw.length < 6) {
      errEl.textContent = "Passwort muss mindestens 6 Zeichen haben.";
      errEl.hidden = false;
      return;
    }

    try {
      if (state.authMode === "register") {
        await Store.register(email, pw, name);
        showToast("Willkommen!");
      } else {
        await Store.login(email, pw);
        showToast("Angemeldet");
      }
      // Auf onAuthChange-Callback gewartet
    } catch (err) {
      errEl.textContent = mapAuthError(err);
      errEl.hidden = false;
    }
  }

  function mapAuthError(err) {
    const code = (err && err.code) || "";
    if (code.includes("invalid-email"))            return "E-Mail-Adresse ist ungültig.";
    if (code.includes("email-already-in-use"))     return "Diese E-Mail ist bereits registriert.";
    if (code.includes("weak-password"))            return "Passwort ist zu schwach (min. 6 Zeichen).";
    if (code.includes("user-not-found") ||
        code.includes("wrong-password") ||
        code.includes("invalid-credential") ||
        code.includes("invalid-login-credentials")) return "E-Mail oder Passwort falsch.";
    if (code.includes("too-many-requests"))        return "Zu viele Versuche – kurz warten und neu probieren.";
    if (code.includes("network"))                  return "Netzwerkfehler – Verbindung prüfen.";
    return (err && err.message) || "Etwas ist schiefgegangen.";
  }

  /* ---------- Boxes view (Bibliothek) ---------- */
  async function renderBoxes() {
    const user = Store.getCurrentUser();
    if (!user) return;

    const grid = $("#boxes-grid");
    const empty = $("#boxes-empty");
    const boxes = await Store.getLibraryBoxes();
    const filter = state.boxFilter.trim().toLowerCase();
    const filtered = filter
      ? boxes.filter((c) => c.name.toLowerCase().includes(filter))
      : boxes;

    if (boxes.length === 0) {
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
      const isOwn = cat.ownerId === user.uid;
      const linkedBadge = !isOwn
        ? `<div class="linked-badge" title="Verknüpfte Box">🔗 von ${escapeHtml(authorName(cat.ownerId))}</div>`
        : "";
      const publishedBadge = isOwn && cat.published
        ? `<div class="published-badge" title="Veröffentlicht">✓ veröffentlicht</div>`
        : "";
      const editBtn = isOwn
        ? `<button class="icon-btn" data-action="edit-box" data-id="${cat.id}"
                  aria-label="Box bearbeiten" title="Bearbeiten">✎</button>`
        : "";
      const publishBtn = isOwn
        ? `<button class="icon-btn" data-action="open-publish" data-id="${cat.id}"
                  aria-label="Veröffentlichen" title="Veröffentlichen">📤</button>`
        : "";

      return `
        <div class="box-tile ${isOwn ? "" : "is-linked"}" data-id="${cat.id}" data-action="open-box"
             style="--tile-color: ${cat.color}">
          <div class="box-tile-tools">
            ${publishBtn}
            ${editBtn}
          </div>
          <div>
            <div class="box-tile-dot"></div>
            <div class="box-tile-name">${escapeHtml(cat.name)}</div>
            ${linkedBadge}
            ${publishedBadge}
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

  /* ---------- Shop view ---------- */
  async function renderShop() {
    const user = Store.getCurrentUser();
    if (!user) return;

    const grid = $("#shop-grid");
    const empty = $("#shop-empty");
    const boxes = await Store.getPublishedBoxes();
    const filter = state.shopFilter.trim().toLowerCase();
    const filtered = filter
      ? boxes.filter((c) =>
          c.name.toLowerCase().includes(filter) ||
          (c.description || "").toLowerCase().includes(filter))
      : boxes;

    if (boxes.length === 0) {
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

    grid.innerHTML = filtered.map((cat) => {
      const count = countByCat[cat.id] || 0;
      const isOwn = cat.ownerId === user.uid;
      const inLib = Store.isInLibrary(cat.id);
      const btn = isOwn
        ? `<button class="btn ghost btn-sm" data-action="open-box" data-id="${cat.id}">Eigene Box</button>`
        : inLib
          ? `<button class="btn ghost btn-sm" data-action="remove-from-library" data-id="${cat.id}">✓ In Bibliothek</button>`
          : `<button class="btn primary btn-sm" data-action="add-to-library" data-id="${cat.id}">+ Hinzufügen</button>`;

      return `
        <div class="shop-tile" data-id="${cat.id}" style="--tile-color: ${cat.color}">
          <div>
            <div class="box-tile-dot"></div>
            <div class="box-tile-name">${escapeHtml(cat.name)}</div>
            <div class="shop-tile-author">von ${escapeHtml(authorName(cat.ownerId))}</div>
            ${cat.description
              ? `<p class="shop-tile-desc">${escapeHtml(cat.description)}</p>`
              : `<p class="shop-tile-desc muted"><em>Keine Beschreibung</em></p>`}
          </div>
          <div class="shop-tile-footer">
            <span class="box-tile-meta">${count} Karte${count === 1 ? "" : "n"}</span>
            ${btn}
          </div>
        </div>`;
    }).join("");
  }

  /* ---------- Profile view ---------- */
  async function renderProfile() {
    const stats = await Store.getProfileStats();
    if (!stats) return;
    const el = $("#profile-content");

    const accuracy = stats.learning.accuracy;
    const accColor = accuracy === null ? "var(--muted)"
                   : accuracy >= 75    ? "var(--success)"
                   : accuracy >= 50    ? "var(--accent)"
                                        : "var(--danger)";

    const maxDay = Math.max(1, ...stats.learning.last7.map((d) => d.count));
    const days = stats.learning.last7.map((d, i) => {
      const date = new Date(d.dayStart);
      const isToday = i === stats.learning.last7.length - 1;
      const heightPct = Math.round((d.count / maxDay) * 100);
      const labels = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
      const dayLabel = labels[date.getDay()];
      return `
        <div class="bar-col ${isToday ? "is-today" : ""}" title="${d.count} Karte${d.count === 1 ? "" : "n"} am ${formatDate(d.dayStart)}">
          <div class="bar-value">${d.count || ""}</div>
          <div class="bar" style="height: ${Math.max(4, heightPct)}%"></div>
          <div class="bar-label">${dayLabel}</div>
        </div>`;
    }).join("");

    const topBox = stats.learning.topBox;
    const mostInst = stats.community.mostInstalledBox;

    el.innerHTML = `
      <div class="profile-grid">

        <section class="glass profile-section">
          <h2>Account</h2>
          <div class="account-info">
            <div class="avatar">${escapeHtml((stats.user.displayName || "?").slice(0, 1).toUpperCase())}</div>
            <div>
              <div class="account-name">${escapeHtml(stats.user.displayName)}</div>
              <div class="muted">${escapeHtml(stats.user.email)}</div>
              <div class="muted small">Mitglied seit ${formatDate(stats.user.createdAt)}</div>
            </div>
          </div>
        </section>

        <section class="glass profile-section">
          <h2>Bibliothek</h2>
          <div class="stat-row">
            <div class="stat-cell">
              <div class="stat-value">${stats.library.ownCount}</div>
              <div class="stat-label">Eigene Boxen</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${stats.library.linkedCount}</div>
              <div class="stat-label">Verknüpfte Boxen</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${stats.library.totalCards}</div>
              <div class="stat-label">Karten gesamt</div>
            </div>
          </div>
        </section>

        <section class="glass profile-section profile-learning">
          <h2>Lernverhalten</h2>
          <div class="stat-row">
            <div class="stat-cell">
              <div class="stat-value">${stats.learning.seen}</div>
              <div class="stat-label">Beantwortet</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value" style="color:${accColor}">${accuracy === null ? "–" : accuracy + "%"}</div>
              <div class="stat-label">Trefferquote</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${stats.learning.currentStreak} 🔥</div>
              <div class="stat-label">Aktuelle Streak</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${stats.learning.longestStreak}</div>
              <div class="stat-label">Längste Streak</div>
            </div>
          </div>
          ${topBox ? `
            <div class="profile-row">
              <span class="muted">Meist gelernte Box:</span>
              <span class="pill" style="--tile-color:${topBox.color}">
                <span class="pill-dot"></span>${escapeHtml(topBox.name)} · ${stats.learning.topBoxSeen}×
              </span>
            </div>` : ""}
          <div class="chart-wrap">
            <div class="chart-title">Aktivität (letzte 7 Tage)</div>
            <div class="chart-bars">${days}</div>
          </div>
        </section>

        <section class="glass profile-section">
          <h2>Community-Impact</h2>
          <div class="stat-row">
            <div class="stat-cell">
              <div class="stat-value">${stats.community.publishedCount}</div>
              <div class="stat-label">Veröffentlicht</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${stats.community.totalInstalls}</div>
              <div class="stat-label">Hinzugefügt von anderen</div>
            </div>
          </div>
          ${mostInst ? `
            <div class="profile-row">
              <span class="muted">Beliebteste Box:</span>
              <span class="pill" style="--tile-color:${mostInst.color}">
                <span class="pill-dot"></span>${escapeHtml(mostInst.name)} · ${mostInst.installCount || 0}×
              </span>
            </div>` : `
            <p class="muted small">Veröffentliche eine Box, um deine Reichweite zu sehen.</p>`}
        </section>

      </div>`;
  }

  /* ---------- Cards view ---------- */
  async function renderCards() {
    const user = Store.getCurrentUser();
    if (!user) return;

    const cat = await Store.getCategory(state.currentCategoryId);
    if (!cat) { setView("boxes"); renderBoxes(); return; }

    const isOwn = cat.ownerId === user.uid;

    $("#box-title").textContent = cat.name;

    const grid = $("#cards-grid");
    const empty = $("#cards-empty");
    const meta = $("#box-meta");
    const actions = $("#box-actions");
    const authorEl = $("#box-author");
    const descEl = $("#box-description");

    const cards = await Store.getCards(cat.id);
    meta.textContent = `${cards.length} Karte${cards.length === 1 ? "" : "n"}`;

    if (isOwn) {
      authorEl.hidden = true;
    } else {
      authorEl.hidden = false;
      authorEl.innerHTML = `🔗 von <strong>${escapeHtml(authorName(cat.ownerId))}</strong> · schreibgeschützt`;
    }
    if (cat.description) {
      descEl.hidden = false;
      descEl.textContent = cat.description;
    } else {
      descEl.hidden = true;
    }

    const studyDisabled = cards.length === 0;
    actions.innerHTML = `
      <button class="btn ghost" data-action="study-start" ${studyDisabled ? "disabled style='opacity:.4;pointer-events:none'" : ""}>Lernen starten</button>
      ${isOwn
        ? `<button class="btn primary" data-action="new-card">+ Neue Karte</button>
           <button class="btn icon" data-action="open-publish" data-id="${cat.id}" title="${cat.published ? "Veröffentlichung verwalten" : "Veröffentlichen"}">📤</button>
           <button class="btn icon" data-action="delete-box" title="Box löschen" aria-label="Box löschen">🗑</button>`
        : `<button class="btn ghost" data-action="remove-from-library" data-id="${cat.id}">Aus Bibliothek entfernen</button>`}
    `;

    if (cards.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      $("#cards-empty-text").textContent = isOwn
        ? "Erstelle deine erste Karteikarte mit Frage und Antwort."
        : "Diese Box enthält noch keine Karten.";
      $("#cards-empty-btn").hidden = !isOwn;
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
      const editActions = isOwn ? `
        <div class="card-item-actions">
          <button class="icon-btn" data-action="edit-card" data-id="${card.id}"
                  aria-label="Karte bearbeiten" title="Bearbeiten">✎</button>
          <button class="icon-btn" data-action="delete-card" data-id="${card.id}"
                  aria-label="Karte löschen" title="Löschen">🗑</button>
        </div>` : "";

      return `
        <div class="card-item" data-id="${card.id}">
          ${editActions}
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
    $("#modal-box").classList.add("is-open");
    if (!matchMedia("(pointer: coarse)").matches) {
      setTimeout(() => $("#box-name").focus(), 50);
    }
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
    $("#modal-card").classList.add("is-open");
    if (!matchMedia("(pointer: coarse)").matches) {
      setTimeout(() => $("#card-front").focus(), 50);
    }
  }

  async function openPublishModal(categoryId) {
    const cat = await Store.getCategory(categoryId);
    if (!cat) return;
    state.modal.type = "publish";
    state.modal.editingId = categoryId;

    $("#publish-description").value = cat.description || "";
    $("#publish-status-text").textContent = cat.published
      ? "Diese Box ist im Shop verfügbar. Du kannst die Beschreibung anpassen oder die Veröffentlichung zurückziehen."
      : "Andere Nutzer können diese Box im Shop sehen und ihrer Bibliothek hinzufügen.";
    $("#publish-submit-btn").textContent = cat.published ? "Speichern" : "Veröffentlichen";
    $("#unpublish-btn").hidden = !cat.published;
    $("#modal-publish").classList.add("is-open");
  }

  function closeModals() {
    $("#modal-box").classList.remove("is-open");
    $("#modal-card").classList.remove("is-open");
    $("#modal-publish").classList.remove("is-open");
    state.modal.type = null;
    state.modal.editingId = null;
  }

  async function saveBox() {
    const name = $("#box-name").value.trim();
    if (!name) { showToast("Bitte gib einen Namen ein"); return; }
    try {
      if (state.modal.editingId) {
        await Store.updateCategory(state.modal.editingId, { name, color: state.modal.color });
        showToast("Box aktualisiert");
      } else {
        await Store.addCategory(name, state.modal.color);
        showToast("Box erstellt");
      }
      closeModals();
      renderBoxes();
    } catch (err) {
      showToast(err.message || "Fehler beim Speichern");
    }
  }

  async function saveCard() {
    const front = $("#card-front").value.trim();
    const back  = $("#card-back").value.trim();
    if (!front && !back) { showToast("Bitte fülle mindestens eine Seite aus"); return; }
    try {
      if (state.modal.editingId) {
        await Store.updateCard(state.modal.editingId, { front, back });
        showToast("Karte aktualisiert");
      } else {
        await Store.addCard(state.currentCategoryId, front, back);
        showToast("Karte hinzugefügt");
      }
      closeModals();
      renderCards();
    } catch (err) {
      showToast(err.message || "Fehler beim Speichern");
    }
  }

  async function submitPublish() {
    const id = state.modal.editingId;
    if (!id) return;
    const desc = $("#publish-description").value.trim();
    if (!desc) { showToast("Bitte eine kurze Beschreibung angeben"); return; }
    try {
      await Store.publishCategory(id, desc);
      showToast("Box veröffentlicht");
      closeModals();
      if (state.view === "boxes") renderBoxes();
      if (state.view === "cards") renderCards();
    } catch (err) {
      showToast(err.message || "Fehler");
    }
  }

  async function submitUnpublish() {
    const id = state.modal.editingId;
    if (!id) return;
    try {
      await Store.unpublishCategory(id);
      showToast("Veröffentlichung zurückgezogen");
      closeModals();
      if (state.view === "boxes") renderBoxes();
      if (state.view === "cards") renderCards();
    } catch (err) {
      showToast(err.message || "Fehler");
    }
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
    if (!card) return;

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
    try {
      await Store.recordAnswer(card.id, correct);
    } catch (err) {
      // weiter, auch wenn Speichern fehlschlug
      console.error(err);
    }
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
      case "auth-switch":
        state.authMode = target.dataset.mode || "login";
        renderAuth();
        break;

      case "auth-submit":
        e.preventDefault();
        submitAuth();
        break;

      case "logout":
        if (confirm("Wirklich abmelden?")) {
          await Store.logout();
          showToast("Abgemeldet");
        }
        break;

      case "go-home":
      case "goto-boxes":
        if (!Store.getCurrentUser()) return;
        state.currentCategoryId = null;
        setView("boxes");
        renderBoxes();
        break;

      case "goto-shop":
        if (!Store.getCurrentUser()) return;
        setView("shop");
        renderShop();
        break;

      case "goto-profile":
        if (!Store.getCurrentUser()) return;
        setView("profile");
        renderProfile();
        break;

      case "new-box":
        openBoxModal();
        break;

      case "edit-box":
        e.stopPropagation();
        openBoxModal(id);
        break;

      case "open-publish":
        e.stopPropagation();
        openPublishModal(id);
        break;

      case "publish-submit":
        submitPublish();
        break;

      case "unpublish":
        submitUnpublish();
        break;

      case "add-to-library":
        e.stopPropagation();
        try {
          await Store.addToLibrary(id);
          showToast("Zur Bibliothek hinzugefügt");
          renderShop();
        } catch (err) {
          showToast(err.message || "Fehler");
        }
        break;

      case "remove-from-library":
        e.stopPropagation();
        {
          const cat = await Store.getCategory(id);
          const isOwn = cat && Store.isOwner(id);
          const msg = isOwn
            ? "Diese Box und alle ihre Karten wirklich löschen?"
            : "Diese verknüpfte Box aus deiner Bibliothek entfernen?";
          if (!confirm(msg)) break;
          try {
            await Store.removeFromLibrary(id);
            showToast(isOwn ? "Box gelöscht" : "Aus Bibliothek entfernt");
            if (state.view === "cards") {
              state.currentCategoryId = null;
              setView("boxes");
              renderBoxes();
            } else if (state.view === "shop") {
              renderShop();
            } else {
              renderBoxes();
            }
          } catch (err) {
            showToast(err.message || "Fehler");
          }
        }
        break;

      case "open-box":
        state.currentCategoryId = id;
        state.cardFilter = "";
        $("#search-cards") && ($("#search-cards").value = "");
        setView("cards");
        renderCards();
        break;

      case "delete-box":
        if (confirm("Diese Box und alle ihre Karten wirklich löschen?")) {
          try {
            await Store.deleteCategory(state.currentCategoryId);
            state.currentCategoryId = null;
            showToast("Box gelöscht");
            setView("boxes");
            renderBoxes();
          } catch (err) {
            showToast(err.message || "Fehler");
          }
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
          try {
            await Store.deleteCard(id);
            showToast("Karte gelöscht");
            renderCards();
          } catch (err) {
            showToast(err.message || "Fehler");
          }
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

    // Auth-Formular Submit (Enter)
    $("#auth-form").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });

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
    const onSearch = (sel, set) => {
      const el = $(sel);
      if (el) el.addEventListener("input", set);
    };
    onSearch("#search-boxes", (e) => { state.boxFilter  = e.target.value; renderBoxes(); });
    onSearch("#search-cards", (e) => { state.cardFilter = e.target.value; renderCards(); });
    onSearch("#search-shop",  (e) => { state.shopFilter = e.target.value; renderShop();  });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#modal-box").classList.contains("is-open") ||
            $("#modal-card").classList.contains("is-open") ||
            $("#modal-publish").classList.contains("is-open")) closeModals();
      }
      if (state.view === "study" && state.study.revealed) {
        if (e.key === "ArrowLeft"  || e.key === "1") answerStudy(false);
        if (e.key === "ArrowRight" || e.key === "2") answerStudy(true);
      }
    });

    // Modal enter to save
    $("#box-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBox();
    });
  }

  /* ---------- Boot ---------- */
  let rerenderScheduled = false;
  function scheduleRerender() {
    if (rerenderScheduled) return;
    rerenderScheduled = true;
    requestAnimationFrame(() => {
      rerenderScheduled = false;
      if (state.view === "boxes")   renderBoxes();
      else if (state.view === "cards") renderCards();
      else if (state.view === "shop")  renderShop();
      else if (state.view === "profile") renderProfile();
    });
  }

  function onAuthChanged(user) {
    if (user) {
      // Nach Login direkt in die Bibliothek
      if (state.view === "auth") {
        setView("boxes");
        renderBoxes();
      } else {
        updateNav();
        if (state.view === "profile") renderProfile();
      }
    } else {
      state.currentCategoryId = null;
      state.authMode = "login";
      renderAuth();
      setView("auth");
    }
  }

  function init() {
    closeModals();
    bindEvents();
    renderAuth();
    setView("auth");
    if (window.Store) {
      window.Store.subscribe(scheduleRerender);
      window.Store.onAuthChange(onAuthChanged);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
