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
    viewedUserId: null,
    cardsListExpanded: false,
    editingDisplayName: false,
    boxFilter: "",
    cardFilter: "",
    shopFilter: "",
    communityFilter: "",
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

  // Mini-Queue: schnelle Folgenachrichten würden sich sonst gegenseitig überschreiben,
  // bevor der User sie lesen kann. FIFO mit kurzer Pause zwischen den Einträgen.
  const TOAST_SHOW_MS = 1800;
  const TOAST_GAP_MS  = 150;
  function showToast(msg) {
    (showToast._q = showToast._q || []).push(String(msg));
    if (!showToast._running) drainToastQueue();
  }
  function drainToastQueue() {
    const queue = showToast._q || [];
    if (queue.length === 0) { showToast._running = false; return; }
    const el = $("#toast");
    if (!el) {
      // DOM noch nicht bereit – kurz warten, Queue NICHT konsumieren.
      showToast._running = true;
      setTimeout(drainToastQueue, 100);
      return;
    }
    showToast._running = true;
    el.textContent = queue.shift();
    el.hidden = false;
    setTimeout(() => {
      el.hidden = true;
      setTimeout(drainToastQueue, TOAST_GAP_MS);
    }, TOAST_SHOW_MS);
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

  function dueLabel(progress) {
    if (!progress || progress.seen === 0) return { text: "neu", cls: "is-new" };
    const now = Date.now();
    const diffMs = (progress.dueAt || 0) - now;
    if (diffMs <= 0) return { text: "fällig", cls: "is-due" };
    const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    if (days <= 1) return { text: "morgen", cls: "is-soon" };
    return { text: `in ${days} T.`, cls: "is-later" };
  }

  /* ---------- View routing ---------- */
  function setView(name) {
    if (state.view === "cards" && name !== "cards") {
      state.cardsListExpanded = false;
    }
    if (state.view === "profile" && name !== "profile") {
      state.editingDisplayName = false;
    }
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
    const mapping = { boxes: "goto-boxes", shop: "goto-shop", community: "goto-community", profile: "goto-profile" };
    const active = mapping[state.view];
    $$(".nav-tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.action === active);
    });
  }

  async function renderCrumbs() {
    const el = $("#crumbs");
    if (!Store.getCurrentUser()) { el.innerHTML = ""; return; }
    if (state.view === "boxes" || state.view === "shop" || state.view === "community" || state.view === "profile" || state.view === "auth") {
      el.innerHTML = "";
      return;
    }
    if (state.view === "user-profile") {
      const u = state.viewedUserId ? Store.getUser(state.viewedUserId) : null;
      const name = (u && u.displayName) || "Profil";
      el.innerHTML = `<span>Community</span><span>${escapeHtml(name)}</span>`;
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
    const cardsByCat = cards.reduce((acc, c) => {
      (acc[c.categoryId] = acc[c.categoryId] || []).push(c);
      return acc;
    }, {});

    const now = Date.now();
    const tiles = filtered.map((cat) => {
      const list = cardsByCat[cat.id] || [];
      const count = list.length;
      const dueCount = list.filter((c) => c.progress.seen > 0 && (c.progress.dueAt || 0) <= now).length;
      const newCount = list.filter((c) => c.progress.seen === 0).length;
      const isOwn = cat.ownerId === user.uid;
      const canEdit = isOwn || cat.published === true;
      const linkedBadge = !isOwn
        ? `<div class="linked-badge" title="Verknüpfte Box">🔗 von ${escapeHtml(authorName(cat.ownerId))}</div>`
        : "";
      const publishedBadge = isOwn && cat.published
        ? `<div class="published-badge" title="Veröffentlicht">✓ veröffentlicht</div>`
        : "";
      const editBtn = canEdit
        ? `<button class="icon-btn" data-action="edit-box" data-id="${cat.id}"
                  aria-label="Box bearbeiten" title="Bearbeiten">✎</button>`
        : "";
      const publishBtn = isOwn
        ? `<button class="icon-btn" data-action="open-publish" data-id="${cat.id}"
                  aria-label="Veröffentlichen" title="Veröffentlichen">📤</button>`
        : "";
      const deleteBtn = isOwn
        ? `<button class="icon-btn" data-action="delete-box" data-id="${cat.id}"
                  aria-label="Box löschen" title="Löschen">🗑</button>`
        : "";
      const srsMeta = (dueCount || newCount)
        ? `<span class="srs-meta">${dueCount ? `<span class="badge is-due">${dueCount} fällig</span>` : ""}${newCount ? `<span class="badge is-new">${newCount} neu</span>` : ""}</span>`
        : "";

      return `
        <div class="box-tile ${isOwn ? "" : "is-linked"}" data-id="${cat.id}" data-action="open-box"
             style="--tile-color: ${cat.color}">
          <div class="box-tile-tools">
            ${publishBtn}
            ${editBtn}
            ${deleteBtn}
          </div>
          <div>
            <div class="box-tile-dot"></div>
            <div class="box-tile-name">${escapeHtml(cat.name)}</div>
            ${linkedBadge}
            ${publishedBadge}
          </div>
          <div class="box-tile-meta">${count} Karte${count === 1 ? "" : "n"} ${srsMeta}</div>
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

  /* ---------- Community view ---------- */
  async function renderCommunity() {
    const me = Store.getCurrentUser();
    if (!me) return;

    const list = $("#community-list");
    const empty = $("#community-empty");
    const all = Store.getAllUsers()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // Empty-State zeigt sich, wenn außer mir niemand registriert ist.
    // Explizit self herausfiltern statt `length <= 1` – robuster gegen
    // Cache-Edge-Cases (self noch nicht im users-Snapshot).
    const others = all.filter((u) => u.uid !== me.uid);

    if (others.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const filter = state.communityFilter.trim().toLowerCase();
    const filtered = filter
      ? all.filter((u) => (u.displayName || "").toLowerCase().includes(filter))
      : all;

    list.innerHTML = filtered.map((u) => {
      const initial = escapeHtml((u.displayName || "?").slice(0, 1).toUpperCase());
      const isMe = u.uid === me.uid;
      const since = u.createdAt ? `Mitglied seit ${formatDate(u.createdAt)}` : "Mitglied";
      return `
        <div class="user-list-row is-clickable" data-action="view-user-profile" data-uid="${u.uid}"
             role="button" tabindex="0" aria-label="Profil von ${escapeHtml(u.displayName)}">
          <div class="avatar">${initial}</div>
          <div class="user-list-info">
            <div class="user-list-name">${escapeHtml(u.displayName)}${isMe ? ' <span class="badge is-me">Du</span>' : ""}</div>
            <div class="user-list-meta">${since}</div>
          </div>
        </div>`;
    }).join("");
  }

  /* ---------- User profile view (read-only, aus Community) ---------- */
  async function renderUserProfile(uid) {
    const el = $("#user-profile-content");
    if (!uid) { el.innerHTML = ""; return; }
    const stats = await Store.getPublicProfileStats(uid);
    if (!stats) {
      el.innerHTML = `
        <div class="glass profile-section">
          <p class="muted">Dieses Profil ist nicht verfügbar.</p>
        </div>`;
      return;
    }

    const u = stats.user;
    const c = stats.community;
    const mostInst = c.mostInstalledBox;
    const initial = escapeHtml((u.displayName || "?").slice(0, 1).toUpperCase());

    el.innerHTML = `
      <div class="profile-grid">

        <section class="glass profile-section">
          <h2>Account</h2>
          <div class="account-info">
            <div class="avatar">${initial}</div>
            <div>
              <div class="account-name"><span>${escapeHtml(u.displayName)}</span></div>
              <div class="muted small">Mitglied seit ${formatDate(u.createdAt)}</div>
              <div class="muted small">Längste Streak: ${u.longestStreak || 0} 🔥</div>
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
              <div class="stat-value">${stats.library.publishedCount}</div>
              <div class="stat-label">Öffentlich</div>
            </div>
          </div>
          <p class="muted small">Lernfortschritt bleibt privat.</p>
        </section>

        <section class="glass profile-section profile-learning">
          <h2>Community-Impact</h2>
          <div class="stat-row">
            <div class="stat-cell">
              <div class="stat-value">${c.publishedCount}</div>
              <div class="stat-label">Veröffentlicht</div>
            </div>
            <div class="stat-cell">
              <div class="stat-value">${c.totalInstalls}</div>
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
            <p class="muted small">Noch keine Box unter Öffentlich veröffentlicht.</p>`}
        </section>

      </div>`;
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

    const masteryRow = (b) => {
      const pct = Math.round((b.masteryScore || 0) * 100);
      const accPct = b.avgAccuracy !== null ? Math.round(b.avgAccuracy * 100) : null;
      return `
        <div class="mastery-row" data-id="${b.id}" data-action="open-box" style="--tile-color:${b.color}">
          <div class="mastery-head">
            <span class="pill-dot"></span>
            <span class="mastery-name">${escapeHtml(b.name)}</span>
            <span class="mastery-pct">${pct}%</span>
          </div>
          <div class="mastery-bar"><div class="mastery-bar-fill" style="width:${pct}%"></div></div>
          <div class="mastery-meta muted small">
            ${accPct !== null ? `Trefferquote ${accPct}%` : "noch zu wenig Daten"}
            ${b.dueCount ? ` · ${b.dueCount} fällig` : ""}
            ${b.newCount ? ` · ${b.newCount} neu` : ""}
          </div>
        </div>`;
    };

    const topMasteryHtml = stats.learning.topMastery.length
      ? stats.learning.topMastery.map(masteryRow).join("")
      : `<p class="muted small">Übe ein paar Karten in mehreren Boxen, um deine Stärken zu sehen.</p>`;
    const weakMasteryHtml = stats.learning.weakMastery.length
      ? stats.learning.weakMastery.map(masteryRow).join("")
      : `<p class="muted small">Noch keine Schwachstellen erkannt – weiter so!</p>`;
    const hardestHtml = stats.learning.hardestCards.length
      ? stats.learning.hardestCards.map((c) => `
          <div class="hardest-row" ${c.box ? `data-action="open-box" data-id="${c.box.id}"` : ""}
               style="--tile-color:${c.box ? c.box.color : "var(--accent)"}">
            <span class="pill-dot"></span>
            <div class="hardest-text">
              <div class="hardest-front">${escapeHtml(c.front || "—")}</div>
              <div class="muted small">${c.box ? escapeHtml(c.box.name) + " · " : ""}${c.accuracyPct}% richtig · ${c.seen}× geübt</div>
            </div>
          </div>`).join("")
      : `<p class="muted small">Sobald du Karten häufiger übst, erscheinen hier deine schwierigsten.</p>`;

    const learning = stats.learning;
    const dueHighlight = learning.dueToday > 0;

    el.innerHTML = `
      <div class="profile-grid">

        <section class="glass profile-section profile-highlight ${dueHighlight ? "is-due" : ""}">
          <div class="highlight-grid">
            <div>
              <div class="highlight-value">${learning.dueToday}</div>
              <div class="highlight-label">Heute fällig</div>
            </div>
            <div>
              <div class="highlight-value">${learning.retention === null ? "–" : learning.retention + "%"}</div>
              <div class="highlight-label">Retention</div>
            </div>
            <div>
              <div class="highlight-value">${learning.learningSinceDays || 0}</div>
              <div class="highlight-label">Lerntage</div>
            </div>
            ${dueHighlight ? `<button class="btn primary highlight-cta" data-action="goto-boxes">Jetzt üben →</button>` : ""}
          </div>
        </section>

        <section class="glass profile-section">
          <h2>Account</h2>
          <div class="account-info">
            <div class="avatar">${escapeHtml((stats.user.displayName || "?").slice(0, 1).toUpperCase())}</div>
            <div class="account-info-text">
              ${state.editingDisplayName ? `
                <div class="edit-name-form">
                  <input class="input" id="display-name-input" type="text"
                         maxlength="40" value="${escapeHtml(stats.user.displayName || "")}"
                         autocomplete="nickname" />
                  <button class="btn primary btn-sm" data-action="save-display-name">Speichern</button>
                  <button class="btn ghost btn-sm" data-action="cancel-display-name">Abbrechen</button>
                </div>
              ` : `
                <div class="account-name">
                  <span>${escapeHtml(stats.user.displayName)}</span>
                  <button class="icon-btn" data-action="edit-name"
                          aria-label="Anzeigename ändern" title="Anzeigename ändern">✎</button>
                </div>
              `}
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
          <h2>Das beherrschst du gut</h2>
          <div class="mastery-list">${topMasteryHtml}</div>
        </section>

        <section class="glass profile-section">
          <h2>Hier solltest du dranbleiben</h2>
          <div class="mastery-list">${weakMasteryHtml}</div>
        </section>

        <section class="glass profile-section profile-learning">
          <h2>Schwierigste Karten</h2>
          <div class="hardest-list">${hardestHtml}</div>
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

    if (state.editingDisplayName) {
      const input = $("#display-name-input");
      if (input) {
        if (!matchMedia("(pointer: coarse)").matches) {
          setTimeout(() => { input.focus(); input.select(); }, 30);
        }
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); saveDisplayName(); }
          if (e.key === "Escape") { e.preventDefault(); cancelDisplayName(); }
        });
      }
    }
  }

  async function saveDisplayName() {
    const input = $("#display-name-input");
    if (!input) return;
    const value = input.value.trim();
    try {
      await Store.updateDisplayName(value);
      state.editingDisplayName = false;
      showToast("Anzeigename aktualisiert");
      renderProfile();
    } catch (err) {
      showToast(err.message || "Fehler beim Speichern");
    }
  }

  function cancelDisplayName() {
    state.editingDisplayName = false;
    renderProfile();
  }

  /* ---------- Cards view ---------- */
  async function renderCards() {
    const user = Store.getCurrentUser();
    if (!user) return;

    const cat = await Store.getCategory(state.currentCategoryId);
    if (!cat) { setView("boxes"); renderBoxes(); return; }

    const isOwn = cat.ownerId === user.uid;
    const canEdit = Store.canEdit(cat.id);

    $("#box-title").textContent = cat.name;

    const grid = $("#cards-grid");
    const empty = $("#cards-empty");
    const meta = $("#box-meta");
    const actions = $("#box-actions");
    const authorEl = $("#box-author");
    const descEl = $("#box-description");
    const modEl = $("#box-modified");

    const cards = await Store.getCards(cat.id);
    const now = Date.now();
    const dueCount = cards.filter((c) => c.progress.seen > 0 && (c.progress.dueAt || 0) <= now).length;
    const newCount = cards.filter((c) => c.progress.seen === 0).length;
    meta.innerHTML = `${cards.length} Karte${cards.length === 1 ? "" : "n"}`
      + (dueCount ? ` <span class="badge is-due">${dueCount} fällig</span>` : "")
      + (newCount ? ` <span class="badge is-new">${newCount} neu</span>` : "");

    renderBoxStatsBanner(cat, cards.length);
    renderCardsCollapsibleToggle(cards.length);

    if (isOwn) {
      authorEl.hidden = true;
    } else {
      authorEl.hidden = false;
      const editHint = canEdit ? "gemeinschaftlich bearbeitbar" : "schreibgeschützt";
      authorEl.innerHTML = `🔗 von <strong>${escapeHtml(authorName(cat.ownerId))}</strong> · ${editHint}`;
    }
    if (cat.description) {
      descEl.hidden = false;
      descEl.textContent = cat.description;
    } else {
      descEl.hidden = true;
    }
    if (modEl) {
      if (cat.lastModifiedAt) {
        modEl.hidden = false;
        const name = (cat.lastModifiedBy && cat.lastModifiedBy.displayName)
          || (cat.lastModifiedBy && authorName(cat.lastModifiedBy.uid))
          || "Unbekannt";
        modEl.textContent = `Zuletzt geändert von ${name} am ${formatDate(cat.lastModifiedAt)}`;
      } else {
        modEl.hidden = true;
      }
    }

    const studyDisabled = cards.length === 0;
    actions.innerHTML = `
      <button class="btn ghost" data-action="study-start" ${studyDisabled ? "disabled style='opacity:.4;pointer-events:none'" : ""}>Lernen starten</button>
      ${canEdit ? `
        <button class="btn primary" data-action="new-card">+ Neue Karte</button>
        <button class="btn ghost" data-action="open-import" title="Karten importieren">⬆ Import</button>
        <button class="btn icon" data-action="edit-box" data-id="${cat.id}" title="Box bearbeiten" aria-label="Box bearbeiten">✎</button>
      ` : ""}
      ${isOwn ? `
        <button class="btn icon" data-action="open-publish" data-id="${cat.id}" title="${cat.published ? "Veröffentlichung verwalten" : "Veröffentlichen"}">📤</button>
        <button class="btn icon" data-action="delete-box" data-id="${cat.id}" title="Box löschen" aria-label="Box löschen">🗑</button>
      ` : `
        <button class="btn ghost" data-action="remove-from-library" data-id="${cat.id}">Aus Bibliothek entfernen</button>
      `}
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
      const editActions = canEdit ? `
        <div class="card-item-actions">
          <button class="icon-btn" data-action="edit-card" data-id="${card.id}"
                  aria-label="Karte bearbeiten" title="Bearbeiten">✎</button>
          <button class="icon-btn" data-action="delete-card" data-id="${card.id}"
                  aria-label="Karte löschen" title="Löschen">🗑</button>
        </div>` : "";
      const badge = dueLabel(card.progress);

      return `
        <div class="card-item" data-id="${card.id}">
          ${editActions}
          <span class="badge ${badge.cls}">${badge.text}</span>
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

  async function renderBoxStatsBanner(cat, cardCount) {
    const banner = $("#box-stats-banner");
    if (!banner) return;
    if (cardCount === 0) {
      banner.hidden = true;
      banner.innerHTML = "";
      return;
    }
    const s = await Store.getBoxStats(cat.id);
    if (!s) { banner.hidden = true; banner.innerHTML = ""; return; }

    const pct = (v) => v === null ? "–" : Math.round(v * 100) + "%";
    const masteryPct = s.masteryScore !== null ? Math.round(s.masteryScore * 100) : null;
    const masteryColor = masteryPct === null ? "var(--muted)"
                       : masteryPct >= 75    ? "var(--success)"
                       : masteryPct >= 50    ? "var(--accent)"
                                              : "var(--danger)";
    const accuracy = s.overallAccuracy;
    const accColor = accuracy === null ? "var(--muted)"
                   : accuracy >= 0.75  ? "var(--success)"
                   : accuracy >= 0.5   ? "var(--accent)"
                                        : "var(--danger)";

    const summary = s.seenCount === 0
      ? `<p class="muted small" style="margin:0">Noch keine Karten beantwortet — starte „Lernen", um deinen Fortschritt zu sehen.</p>`
      : "";

    banner.hidden = false;
    banner.style.setProperty("--tile-color", cat.color || "var(--accent)");
    banner.innerHTML = `
      <div class="box-stats-head">
        <span class="pill-dot"></span>
        <span class="box-stats-title">Dein Fortschritt</span>
      </div>
      <div class="box-stats-grid">
        <div class="box-stats-cell">
          <div class="box-stats-value" style="color:${accColor}">${pct(accuracy)}</div>
          <div class="box-stats-label">Trefferquote</div>
        </div>
        <div class="box-stats-cell">
          <div class="box-stats-value" style="color:${masteryColor}">${masteryPct === null ? "–" : masteryPct + "%"}</div>
          <div class="box-stats-label">Mastery</div>
        </div>
        <div class="box-stats-cell">
          <div class="box-stats-value">${s.avgEase === null ? "–" : s.avgEase.toFixed(2)}</div>
          <div class="box-stats-label">Ø Ease</div>
        </div>
        <div class="box-stats-cell">
          <div class="box-stats-value">${s.dueCount}</div>
          <div class="box-stats-label">Fällig</div>
        </div>
        <div class="box-stats-cell">
          <div class="box-stats-value">${s.newCount}</div>
          <div class="box-stats-label">Neu</div>
        </div>
        <div class="box-stats-cell">
          <div class="box-stats-value">${s.seenCount}</div>
          <div class="box-stats-label">Antworten</div>
        </div>
      </div>
      ${summary}
    `;
  }

  function renderCardsCollapsibleToggle(cardCount) {
    const toggle = $("#cards-toggle");
    const wrap = $("#cards-collapsible");
    if (!toggle || !wrap) return;
    if (cardCount === 0) {
      // Empty-State sichtbar machen, Toggle ausblenden
      toggle.hidden = true;
      wrap.classList.remove("is-collapsed");
      return;
    }
    // Wenn der Nutzer aktiv sucht, Liste automatisch ausklappen
    if (state.cardFilter.trim()) state.cardsListExpanded = true;
    toggle.hidden = false;
    const expanded = !!state.cardsListExpanded;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = `${expanded ? "Karten ausblenden" : "Karten anzeigen"} (${cardCount})`;
    wrap.classList.toggle("is-collapsed", !expanded);
  }

  function toggleCardsList() {
    state.cardsListExpanded = !state.cardsListExpanded;
    const toggle = $("#cards-toggle");
    const wrap = $("#cards-collapsible");
    if (!toggle || !wrap) return;
    const expanded = state.cardsListExpanded;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const grid = $("#cards-grid");
    const total = grid ? grid.children.length : 0;
    toggle.textContent = `${expanded ? "Karten ausblenden" : "Karten anzeigen"} (${total})`;
    wrap.classList.toggle("is-collapsed", !expanded);
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
      ? "Diese Box ist unter Öffentlich verfügbar. Du kannst die Beschreibung anpassen oder die Veröffentlichung zurückziehen."
      : "Andere Nutzer können diese Box unter Öffentlich sehen und ihrer Bibliothek hinzufügen.";
    $("#publish-submit-btn").textContent = cat.published ? "Speichern" : "Veröffentlichen";
    $("#unpublish-btn").hidden = !cat.published;
    $("#modal-publish").classList.add("is-open");
  }

  function closeModals() {
    $("#modal-box").classList.remove("is-open");
    $("#modal-card").classList.remove("is-open");
    $("#modal-publish").classList.remove("is-open");
    $("#modal-confirm").classList.remove("is-open");
    $("#modal-import").classList.remove("is-open");
    state.modal.type = null;
    state.modal.editingId = null;
    _confirmCb = null;
  }

  /* ----- Confirm-Modal (generisch) ----- */
  let _confirmCb = null;
  function openConfirmModal({ title, message, confirmText, cancelText, danger, hideCancel, onConfirm }) {
    $("#confirm-title").textContent = title || "Bestätigen";
    $("#confirm-message").textContent = message || "";
    const ok = $("#confirm-ok-btn");
    ok.textContent = confirmText || "Bestätigen";
    ok.classList.toggle("wrong", !!danger);
    ok.classList.toggle("primary", !danger);
    const cancel = $("#confirm-cancel-btn");
    cancel.textContent = cancelText || "Abbrechen";
    cancel.hidden = !!hideCancel;
    _confirmCb = typeof onConfirm === "function" ? onConfirm : null;
    $("#modal-confirm").classList.add("is-open");
  }
  function resolveConfirm(confirmed) {
    const cb = _confirmCb;
    _confirmCb = null;
    $("#modal-confirm").classList.remove("is-open");
    if (confirmed && cb) {
      try { cb(); } catch (e) { console.error(e); }
    }
  }

  /* ----- CSV/TSV Parser ----- */
  const IMPORT_DELIMS = { tab: "\t", semicolon: ";", comma: "," };
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 10).join("\n");
    const counts = { "\t": 0, ";": 0, ",": 0 };
    for (const ch of sample) if (ch in counts) counts[ch] += 1;
    let best = "\t", bestN = -1;
    Object.entries(counts).forEach(([d, n]) => { if (n > bestN) { best = d; bestN = n; } });
    return bestN > 0 ? best : "\t";
  }
  function splitDelimitedLine(line, delim) {
    const out = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delim) { out.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
  function parseCardsCsv(text, delimiterOpt) {
    const delim = delimiterOpt && delimiterOpt !== "auto" ? delimiterOpt : detectDelimiter(text);
    const lines = text.split(/\r?\n/);
    const valid = [], invalid = [];
    lines.forEach((raw, idx) => {
      const line = raw.trim();
      if (!line) return;
      const parts = splitDelimitedLine(line, delim).map((s) => s.trim());
      if (parts.length < 2 || (!parts[0] && !parts.slice(1).join(""))) {
        invalid.push({ line: idx + 1, raw });
        return;
      }
      const front = parts[0];
      const back = parts.slice(1).join(delim).trim();
      if (!front && !back) { invalid.push({ line: idx + 1, raw }); return; }
      valid.push({ front, back });
    });
    return { valid, invalid, delimiter: delim };
  }

  /* ----- Import Modal ----- */
  function openImportModal() {
    $("#import-text").value = "";
    $("#import-delimiter").value = "auto";
    const fileInput = $("#import-file");
    if (fileInput) fileInput.value = "";
    const nameEl = $("#import-file-name");
    if (nameEl) { nameEl.hidden = true; nameEl.textContent = ""; }
    renderImportPreview();
    $("#modal-import").classList.add("is-open");
  }

  async function loadImportFile(file) {
    if (!file) return;
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BYTES) { showToast("Datei zu groß (max. 5 MB)"); return; }
    try {
      const text = await file.text();
      $("#import-text").value = text;
      const nameEl = $("#import-file-name");
      if (nameEl) {
        nameEl.hidden = false;
        nameEl.textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
      }
      renderImportPreview();
    } catch (err) {
      showToast("Datei konnte nicht gelesen werden");
    }
  }
  function renderImportPreview() {
    const text = $("#import-text").value;
    const delim = $("#import-delimiter").value;
    const out = $("#import-preview");
    if (!text.trim()) { out.innerHTML = '<span class="muted small">Noch nichts eingefügt.</span>'; return; }
    const { valid, invalid, delimiter } = parseCardsCsv(text, delim);
    const delimName = delimiter === "\t" ? "Tab" : delimiter === ";" ? "Semikolon" : "Komma";
    const sample = valid.slice(0, 5).map((c) =>
      `<div class="import-row"><strong>${escapeHtml(c.front)}</strong><span class="muted"> → </span>${escapeHtml(c.back)}</div>`
    ).join("");
    out.innerHTML = `
      <div class="import-stats">
        <span><strong>${valid.length}</strong> Karte${valid.length === 1 ? "" : "n"} erkannt</span>
        ${invalid.length ? `<span class="muted"> · ${invalid.length} ungültig</span>` : ""}
        <span class="muted"> · Trenner: ${delimName}</span>
      </div>
      ${sample ? `<div class="import-sample">${sample}${valid.length > 5 ? `<div class="muted small">… und ${valid.length - 5} weitere</div>` : ""}</div>` : ""}
    `;
  }
  async function submitImport() {
    const text = $("#import-text").value;
    const delim = $("#import-delimiter").value;
    const { valid } = parseCardsCsv(text, delim);
    if (valid.length === 0) { showToast("Keine gültigen Karten erkannt"); return; }
    try {
      await Store.addCardsBatch(state.currentCategoryId, valid);
      showToast(`${valid.length} Karte${valid.length === 1 ? "" : "n"} importiert`);
      closeModals();
      renderCards();
    } catch (err) {
      showToast(err.message || "Fehler beim Import");
    }
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
  const MAX_NEW_PER_SESSION = 10;

  function buildSrsDeck(cards) {
    const now = Date.now();
    const due = cards.filter((c) => c.progress.seen > 0 && (c.progress.dueAt || 0) <= now)
      .sort((a, b) => (a.progress.dueAt || 0) - (b.progress.dueAt || 0));
    const fresh = shuffle(cards.filter((c) => c.progress.seen === 0).slice())
      .slice(0, MAX_NEW_PER_SESSION);
    return [...due, ...fresh];
  }

  async function startStudy(forceAll = false) {
    const cards = await Store.getCards(state.currentCategoryId);
    if (cards.length === 0) { showToast("Keine Karten zum Lernen"); return; }
    let deck = forceAll ? shuffle(cards.slice()) : buildSrsDeck(cards);
    if (deck.length === 0) {
      openConfirmModal({
        title: "Alles aktuell!",
        message: "Keine Karten sind heute fällig. Möchtest du trotzdem alle Karten durchgehen?",
        confirmText: "Alle üben",
        onConfirm: () => startStudy(true),
      });
      return;
    }
    state.study = {
      deck,
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
    // Bar zeigt die Position der aktuell sichtbaren Karte (1/n … n/n),
    // konsistent mit dem `${index+1} / ${total}`-Label direkt darüber.
    $("#study-progress").style.width = `${((index + 1) / total) * 100}%`;

    const flip = $("#flipcard");
    flip.classList.toggle("flipped", revealed);

    const actions = $("#study-actions");
    actions.classList.toggle("revealed", revealed);
  }

  async function answerStudy(correct) {
    if (!state.study.revealed) return;
    // Bounds-Guard: falls der globale cards-Listener während des Lernens feuert
    // (z. B. weil ein zweiter Tab eine Karte löscht), kann der Index ins Leere zeigen.
    const card = state.study.deck[state.study.index];
    if (!card) { finishStudy(); return; }

    try {
      await Store.recordAnswer(card.id, correct);
    } catch (err) {
      // Speichern fehlgeschlagen: Index NICHT erhöhen, Karte bleibt aktiv,
      // damit der User es nach Reconnect erneut versuchen kann.
      console.error(err);
      showToast(err.message || "Antwort konnte nicht gespeichert werden");
      return;
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
        openConfirmModal({
          title: "Abmelden?",
          message: "Du wirst aus deinem Konto abgemeldet.",
          confirmText: "Abmelden",
          onConfirm: async () => {
            await Store.logout();
            showToast("Abgemeldet");
          },
        });
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

      case "goto-community":
        if (!Store.getCurrentUser()) return;
        setView("community");
        renderCommunity();
        break;

      case "goto-profile":
        if (!Store.getCurrentUser()) return;
        setView("profile");
        renderProfile();
        break;

      case "view-user-profile": {
        if (!Store.getCurrentUser()) return;
        const targetUid = target.dataset.uid;
        if (!targetUid) return;
        const me = Store.getCurrentUser();
        if (me && targetUid === me.uid) {
          setView("profile");
          renderProfile();
        } else {
          state.viewedUserId = targetUid;
          setView("user-profile");
          renderUserProfile(targetUid);
        }
        break;
      }

      case "toggle-cards-list":
        toggleCardsList();
        break;

      case "edit-name":
        state.editingDisplayName = true;
        renderProfile();
        break;

      case "save-display-name":
        saveDisplayName();
        break;

      case "cancel-display-name":
        cancelDisplayName();
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
          const isOwnBox = cat && Store.isOwner(id);
          if (isOwnBox && cat.published) {
            openConfirmModal({
              title: "Box ist veröffentlicht",
              message: "Diese Box ist unter Öffentlich veröffentlicht und kann nicht gelöscht werden. Entferne sie zuerst von dort.",
              confirmText: "OK",
              hideCancel: true,
            });
            break;
          }
          openConfirmModal({
            title: isOwnBox ? "Box löschen?" : "Aus Bibliothek entfernen?",
            message: isOwnBox
              ? "Diese Box und alle ihre Karten werden unwiderruflich gelöscht."
              : "Die verknüpfte Box wird aus deiner Bibliothek entfernt.",
            confirmText: isOwnBox ? "Löschen" : "Entfernen",
            danger: isOwnBox,
            onConfirm: async () => {
              try {
                await Store.removeFromLibrary(id);
                showToast(isOwnBox ? "Box gelöscht" : "Aus Bibliothek entfernt");
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
            },
          });
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
        e.stopPropagation();
        {
          const delId = id || state.currentCategoryId;
          const cat = await Store.getCategory(delId);
          if (!cat) break;
          if (cat.published) {
            openConfirmModal({
              title: "Box ist veröffentlicht",
              message: "Diese Box ist unter Öffentlich veröffentlicht und kann nicht gelöscht werden. Entferne sie zuerst von dort.",
              confirmText: "OK",
              hideCancel: true,
            });
            break;
          }
          openConfirmModal({
            title: "Box löschen?",
            message: `„${cat.name}" und alle ihre Karten werden unwiderruflich gelöscht.`,
            confirmText: "Löschen",
            danger: true,
            onConfirm: async () => {
              try {
                await Store.deleteCategory(delId);
                if (state.currentCategoryId === delId) state.currentCategoryId = null;
                showToast("Box gelöscht");
                setView("boxes");
                renderBoxes();
              } catch (err) {
                showToast(err.message || "Fehler");
              }
            },
          });
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
        openConfirmModal({
          title: "Karte löschen?",
          message: "Diese Karte wird unwiderruflich gelöscht.",
          confirmText: "Löschen",
          danger: true,
          onConfirm: async () => {
            try {
              await Store.deleteCard(id);
              showToast("Karte gelöscht");
              renderCards();
            } catch (err) {
              showToast(err.message || "Fehler");
            }
          },
        });
        break;

      case "open-import":
        openImportModal();
        break;

      case "import-submit":
        submitImport();
        break;

      case "confirm-ok":
        resolveConfirm(true);
        break;

      case "confirm-cancel":
        resolveConfirm(false);
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
        openConfirmModal({
          title: "Lernen beenden?",
          message: "Dein bisheriger Fortschritt in dieser Runde geht verloren.",
          confirmText: "Beenden",
          onConfirm: () => { setView("cards"); renderCards(); },
        });
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

    // Tastatur-Aktivierung für a11y-Buttons (z.B. User-Zeile in Community)
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target.closest('[data-action][role="button"]');
      if (!t) return;
      e.preventDefault();
      t.click();
    });

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
    onSearch("#search-community", (e) => { state.communityFilter = e.target.value; renderCommunity(); });

    // Import-Preview live updaten
    const importText = $("#import-text");
    const importDelim = $("#import-delimiter");
    if (importText) importText.addEventListener("input", renderImportPreview);
    if (importDelim) importDelim.addEventListener("change", renderImportPreview);

    // Import: Datei-Upload + Drag&Drop
    const importDrop = $("#import-dropzone");
    const importFile = $("#import-file");
    if (importDrop && importFile) {
      importDrop.addEventListener("click", (e) => {
        if (e.target.closest("textarea, input, button")) return;
        importFile.click();
      });
      importDrop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); importFile.click(); }
      });
      importDrop.setAttribute("tabindex", "0");
      importDrop.setAttribute("role", "button");
      importFile.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) loadImportFile(f);
      });
      ["dragenter", "dragover"].forEach((ev) => {
        importDrop.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          importDrop.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach((ev) => {
        importDrop.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          importDrop.classList.remove("is-dragover");
        });
      });
      importDrop.addEventListener("drop", (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadImportFile(f);
      });
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#modal-confirm").classList.contains("is-open")) { resolveConfirm(false); return; }
        if ($("#modal-import").classList.contains("is-open") ||
            $("#modal-box").classList.contains("is-open") ||
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
      else if (state.view === "community") renderCommunity();
      else if (state.view === "profile") renderProfile();
      else if (state.view === "user-profile") renderUserProfile(state.viewedUserId);
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
        else if (state.view === "community") renderCommunity();
        else if (state.view === "user-profile") renderUserProfile(state.viewedUserId);
      }
    } else {
      state.currentCategoryId = null;
      state.authMode = "login";
      renderAuth();
      setView("auth");
    }
  }

  /* ---------- Offline-Banner ---------- */
  // Zwei Signale: Browser (navigator.onLine) und Firebase (.info/connected).
  // Banner zeigt sich, sobald eines davon "offline" meldet. Firebase wird
  // initial mit kurzer Verzögerung berücksichtigt, weil .info/connected beim
  // ersten Seitenaufruf typischerweise einige hundert ms auf false steht,
  // bevor der WebSocket verbunden ist — wir wollen kein Banner-Flicker.
  const offlineState = { browser: true, firebase: true, firebaseReady: false };
  function updateOfflineBanner() {
    const el = $("#offline-banner");
    if (!el) return;
    const offline = !offlineState.browser
      || (offlineState.firebaseReady && !offlineState.firebase);
    el.hidden = !offline;
  }
  function bindConnectionStatus() {
    offlineState.browser = navigator.onLine !== false;
    window.addEventListener("online",  () => { offlineState.browser = true;  updateOfflineBanner(); });
    window.addEventListener("offline", () => { offlineState.browser = false; updateOfflineBanner(); });
    if (window.Store && typeof window.Store.subscribeConnection === "function") {
      // Erst nach 2 s den Firebase-Status berücksichtigen – verhindert den
      // initialen "kurz offline"-Flash beim Seitenaufruf.
      setTimeout(() => { offlineState.firebaseReady = true; updateOfflineBanner(); }, 2000);
      window.Store.subscribeConnection((connected) => {
        offlineState.firebase = connected;
        updateOfflineBanner();
      });
    }
    updateOfflineBanner();
  }

  async function init() {
    closeModals();
    bindEvents();
    renderAuth();
    if (!window.Store) return;
    bindConnectionStatus();
    // Warte einmalig auf den ersten Firebase-Auth-State-Check, bevor wir eine
    // View zeigen – sonst blitzt beim Reload kurz die Login-Seite auf, bevor
    // die gespeicherte Session erkannt wird.
    await window.Store.authReady();
    if (window.Store.getCurrentUser()) {
      setView("boxes");
      renderBoxes();
    } else {
      setView("auth");
    }
    window.Store.subscribe(scheduleRerender);
    window.Store.onAuthChange(onAuthChanged);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
