/* =============================================================================
 * Flashcards – Data Access Layer
 * Backed by Firebase Realtime Database + Firebase Auth.
 *
 * Data model (siehe README / Plan):
 *   users/{uid}                       – Profil (displayName, createdAt, longestStreak)
 *   categories/{id}                   – Boxen (mit ownerId, published, description, installCount)
 *   cards/{id}                        – Karten (kein progress mehr)
 *   userLibrary/{uid}/{categoryId}    – verknüpfte + eigene Boxen in der Bibliothek
 *   userProgress/{uid}/{cardId}       – Lernfortschritt pro Nutzer
 * ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getDatabase, ref, onValue, set, update, remove, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile,
  setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDf19KTKfpjKZyLRR4guw18Em3B6FqoTp8",
  authDomain: "flashcards-98d40.firebaseapp.com",
  databaseURL: "https://flashcards-98d40-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "flashcards-98d40",
  storageBucket: "flashcards-98d40.firebasestorage.app",
  messagingSenderId: "269035893008",
  appId: "1:269035893008:web:caec98e8ff6a6aa8713595",
  measurementId: "G-Y3041VDZ3F",
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch((e) =>
  console.warn("[Store] could not set auth persistence", e));

analyticsSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});

/* ---------- helpers ---------- */

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- state ---------- */

const cache = {
  categories: {},
  cards: {},
  users: {},
  userLibrary: {},   // categoryId -> true (für currentUser)
  userProgress: {},  // cardId -> { seen, correct, wrong, lastReviewed }
};

let currentUser = null;       // { uid, email, displayName }
const dataListeners = new Set();
const authListeners = new Set();

let userScopedUnsubs = [];    // unsubscribe-Funktionen für nutzerspezifische Listener

function notify() {
  dataListeners.forEach((cb) => {
    try { cb(cache); } catch (e) { console.error("[Store] listener error", e); }
  });
}

function notifyAuth() {
  authListeners.forEach((cb) => {
    try { cb(currentUser); } catch (e) { console.error("[Store] auth listener error", e); }
  });
}

// Promise die resolved, sobald Firebase Auth einmalig den gespeicherten
// Session-Status aus dem LocalStorage geladen und onAuthStateChanged
// das erste Mal gefeuert hat. Verhindert den Login-Flash beim Reload.
let _authReadyResolve;
const _authReady = new Promise((r) => { _authReadyResolve = r; });
let _authReadyDone = false;
function markAuthReady() {
  if (_authReadyDone) return;
  _authReadyDone = true;
  _authReadyResolve();
}

/* ---------- globale Listener (lesen für alle erlaubt, aber Rules verlangen auth) ---------- */

let globalListenersAttached = false;
function attachGlobalListeners() {
  if (globalListenersAttached) return;
  globalListenersAttached = true;

  onValue(ref(db, "categories"), (snap) => {
    cache.categories = snap.val() || {};
    notify();
  }, (err) => console.error("[Store] categories read failed", err));

  onValue(ref(db, "cards"), (snap) => {
    cache.cards = snap.val() || {};
    notify();
  }, (err) => console.error("[Store] cards read failed", err));

  onValue(ref(db, "users"), (snap) => {
    cache.users = snap.val() || {};
    // Wenn der eigene displayName erst nach dem Auth-State-Change in die DB geschrieben
    // wurde (z.B. direkt nach der Registrierung), holen wir ihn jetzt nach.
    if (currentUser) {
      const dbName = cache.users[currentUser.uid] && cache.users[currentUser.uid].displayName;
      if (dbName && dbName !== currentUser.displayName) {
        currentUser = { ...currentUser, displayName: dbName };
        notifyAuth();
      }
    }
    notify();
  }, (err) => console.error("[Store] users read failed", err));
}

/* ---------- Auth-State + user-scoped Listener ---------- */

function attachUserListeners(uidStr) {
  const libRef = ref(db, `userLibrary/${uidStr}`);
  const progRef = ref(db, `userProgress/${uidStr}`);

  const libCb = onValue(libRef, (snap) => {
    cache.userLibrary = snap.val() || {};
    notify();
  }, (err) => console.error("[Store] userLibrary read failed", err));

  const progCb = onValue(progRef, (snap) => {
    cache.userProgress = snap.val() || {};
    notify();
  }, (err) => console.error("[Store] userProgress read failed", err));

  userScopedUnsubs.push(libCb, progCb);
}

function detachUserListeners() {
  userScopedUnsubs.forEach((unsub) => { try { unsub(); } catch (e) {} });
  userScopedUnsubs = [];
  cache.userLibrary = {};
  cache.userProgress = {};
}

onAuthStateChanged(auth, (user) => {
  detachUserListeners();
  if (user) {
    // Priorität: bereits gecachter DB-Name > Firebase-Auth-Profile-Name > Email-Prefix.
    // Der DB-Name ist die "wahre" Quelle (von uns gesetzt), die anderen sind Fallbacks
    // bis der users-Listener den ersten Snapshot geliefert hat.
    const dbName = cache.users[user.uid] && cache.users[user.uid].displayName;
    currentUser = {
      uid: user.uid,
      email: user.email,
      displayName: dbName || user.displayName || (user.email || "").split("@")[0],
    };
    // Globale Listener erst NACH dem ersten Auth attachen — sonst werden sie mit
    // permission_denied stillgelegt (passiert bei frischen Sessions/Sign-ups,
    // wenn die LocalStorage-Auth-Persistenz noch keinen User wiederhergestellt hat).
    attachGlobalListeners();
    attachUserListeners(user.uid);
  } else {
    currentUser = null;
  }
  markAuthReady();
  notifyAuth();
  notify();
});

/* ---------- Streak-Berechnung ---------- */

function computeCurrentStreak(progressMap) {
  const days = new Set();
  Object.values(progressMap || {}).forEach((p) => {
    if (p && p.lastReviewed) days.add(startOfDay(p.lastReviewed));
  });
  if (days.size === 0) return 0;

  const today = startOfDay(Date.now());
  const yesterday = today - DAY_MS;
  let cursor;
  if (days.has(today))      cursor = today;
  else if (days.has(yesterday)) cursor = yesterday;
  else return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

/* ---------- Profil-Statistiken ---------- */

// Öffentlich sichtbare Stats — funktioniert für jede uid, nutzt nur globale Daten
// (users, categories). Kein Zugriff auf userProgress/userLibrary (privat).
function buildPublicProfileStats(uid) {
  const userRecord = cache.users[uid];
  if (!userRecord) return null;

  const isMe = currentUser && currentUser.uid === uid;
  const cats = Object.values(cache.categories);
  const myOwn = cats.filter((c) => c && c.ownerId === uid);

  const published = myOwn.filter((c) => c.published);
  const totalInstalls = published.reduce((sum, c) => sum + (c.installCount || 0), 0);
  let mostInstalledBox = null;
  published.forEach((c) => {
    if (!mostInstalledBox || (c.installCount || 0) > (mostInstalledBox.installCount || 0)) {
      mostInstalledBox = c;
    }
  });

  return {
    user: {
      uid,
      displayName: userRecord.displayName
        || (isMe && currentUser.displayName)
        || "Unbekannt",
      email: isMe ? currentUser.email : null,
      createdAt: userRecord.createdAt || null,
      longestStreak: userRecord.longestStreak || 0,
    },
    library: {
      ownCount: myOwn.length,
      publishedCount: published.length,
    },
    community: {
      publishedCount: published.length,
      totalInstalls,
      mostInstalledBox,
    },
  };
}

// Per-box Stats für den aktuell eingeloggten User. Greift auf userProgress zu
// (nur für die eigene uid erlaubt). Wird im Box-Detail-View für das Banner genutzt.
function buildBoxStatsForCurrentUser(categoryId) {
  if (!currentUser) return null;
  const cat = cache.categories[categoryId];
  if (!cat) return null;

  const cards = Object.values(cache.cards)
    .filter((c) => c && c.categoryId === categoryId);
  const now = Date.now();

  let seen = 0, correct = 0, wrong = 0;
  let dueCount = 0, newCount = 0;
  let easeSum = 0, easeCount = 0;
  let accCardCount = 0, accSum = 0;
  let lastReviewed = 0;

  cards.forEach((card) => {
    const p = progressWithDefaults(cache.userProgress[card.id]);
    seen += p.seen; correct += p.correct; wrong += p.wrong;
    if (p.seen === 0) newCount += 1;
    else if (p.dueAt <= now) dueCount += 1;
    if (p.seen >= 1) { easeSum += p.ease; easeCount += 1; }
    if (p.seen >= 3) { accCardCount += 1; accSum += p.correct / p.seen; }
    if (p.lastReviewed > lastReviewed) lastReviewed = p.lastReviewed;
  });

  const avgAccuracy = accCardCount ? accSum / accCardCount : null;
  const coverage = cards.length ? accCardCount / cards.length : 0;
  const masteryScore = avgAccuracy !== null ? avgAccuracy * coverage : null;
  const overallAccuracy = seen ? correct / seen : null;

  return {
    cardCount: cards.length,
    seenCount: seen,
    correctCount: correct,
    wrongCount: wrong,
    dueCount,
    newCount,
    overallAccuracy,
    avgAccuracy,
    avgEase: easeCount ? easeSum / easeCount : null,
    masteryScore,
    lastReviewed: lastReviewed || null,
  };
}

function buildProfileStats() {
  if (!currentUser) return null;
  const me = cache.users[currentUser.uid] || {};
  const cats = Object.values(cache.categories);
  const myOwn = cats.filter((c) => c && c.ownerId === currentUser.uid);
  const libIds = Object.keys(cache.userLibrary || {});
  const linked = libIds
    .map((id) => cache.categories[id])
    .filter((c) => c && c.ownerId !== currentUser.uid);

  const libBoxIds = new Set([...myOwn.map((c) => c.id), ...linked.map((c) => c.id)]);
  const totalCards = Object.values(cache.cards)
    .filter((card) => card && libBoxIds.has(card.categoryId)).length;

  // Lernverhalten
  let seen = 0, correct = 0, wrong = 0;
  const seenByBox = {};
  let firstReviewed = null;
  Object.entries(cache.userProgress || {}).forEach(([cardId, p]) => {
    if (!p) return;
    seen    += p.seen    || 0;
    correct += p.correct || 0;
    wrong   += p.wrong   || 0;
    const card = cache.cards[cardId];
    if (card) {
      seenByBox[card.categoryId] = (seenByBox[card.categoryId] || 0) + (p.seen || 0);
    }
    if (p.lastReviewed && (!firstReviewed || p.lastReviewed < firstReviewed)) {
      firstReviewed = p.lastReviewed;
    }
  });
  const accuracy = seen ? Math.round((correct / seen) * 100) : null;
  const currentStreak = computeCurrentStreak(cache.userProgress);
  const longestStreak = Math.max(me.longestStreak || 0, currentStreak);

  // Box-Mastery — pro Box aggregieren
  const libBoxes = [...myOwn, ...linked];
  const cardsByBox = {};
  Object.values(cache.cards).forEach((card) => {
    if (!card || !libBoxIds.has(card.categoryId)) return;
    (cardsByBox[card.categoryId] = cardsByBox[card.categoryId] || []).push(card);
  });
  const now = Date.now();
  let dueToday = 0;
  let easyEnoughCount = 0;
  let totalWithProgress = 0;
  const hardestPool = [];

  const boxMastery = libBoxes.map((box) => {
    const cards = cardsByBox[box.id] || [];
    let bSeen = 0, bCorrect = 0, bWrong = 0, bDue = 0, bNew = 0;
    let easeSum = 0, easeCount = 0;
    let accCardCount = 0, accSum = 0;
    cards.forEach((card) => {
      const p = progressWithDefaults(cache.userProgress[card.id]);
      bSeen += p.seen; bCorrect += p.correct; bWrong += p.wrong;
      if (p.seen === 0) bNew += 1;
      else if (p.dueAt <= now) bDue += 1;
      if (p.seen >= 1) {
        easeSum += p.ease; easeCount += 1;
        totalWithProgress += 1;
        if (p.ease >= 2.5) easyEnoughCount += 1;
      }
      if (p.seen >= 3) {
        accCardCount += 1;
        accSum += p.correct / p.seen;
      }
      if (p.seen >= 5) {
        hardestPool.push({
          cardId: card.id, categoryId: card.categoryId,
          front: card.front, accuracy: p.correct / p.seen, seen: p.seen,
        });
      }
    });
    dueToday += bDue;
    const avgAccuracy = accCardCount ? accSum / accCardCount : null;
    const coverage = cards.length ? accCardCount / cards.length : 0;
    const masteryScore = avgAccuracy !== null ? avgAccuracy * coverage : null;
    return {
      id: box.id, name: box.name, color: box.color,
      cardCount: cards.length,
      seenCount: bSeen, dueCount: bDue, newCount: bNew,
      avgAccuracy, avgEase: easeCount ? easeSum / easeCount : null,
      masteryScore,
    };
  });
  const ranked = boxMastery.filter((b) => b.masteryScore !== null);
  const topMastery = ranked.slice().sort((a, b) => b.masteryScore - a.masteryScore).slice(0, 3);
  const weakMastery = ranked.slice().sort((a, b) => a.masteryScore - b.masteryScore).slice(0, 3);
  const hardestCards = hardestPool
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 5)
    .map((c) => ({
      ...c,
      accuracyPct: Math.round(c.accuracy * 100),
      box: cache.categories[c.categoryId] || null,
    }));
  const retention = totalWithProgress
    ? Math.round((easyEnoughCount / totalWithProgress) * 100)
    : null;
  const learningSinceDays = firstReviewed
    ? Math.max(1, Math.round((now - firstReviewed) / DAY_MS) + 1)
    : 0;

  // 7-Tage-Aktivität (heute = letzter Eintrag)
  const today = startOfDay(Date.now());
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = today - i * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    let count = 0;
    Object.values(cache.userProgress || {}).forEach((p) => {
      if (p && p.lastReviewed >= dayStart && p.lastReviewed < dayEnd) count += 1;
    });
    last7.push({ dayStart, count });
  }

  // Meist gelernte Box (eigene oder verknüpfte)
  let topBoxId = null, topBoxSeen = 0;
  Object.entries(seenByBox).forEach(([cid, s]) => {
    if (s > topBoxSeen && libBoxIds.has(cid)) { topBoxId = cid; topBoxSeen = s; }
  });
  const topBox = topBoxId ? cache.categories[topBoxId] : null;

  // Community
  const published = myOwn.filter((c) => c.published);
  const totalInstalls = published.reduce((sum, c) => sum + (c.installCount || 0), 0);
  let mostInstalledBox = null;
  published.forEach((c) => {
    if (!mostInstalledBox || (c.installCount || 0) > (mostInstalledBox.installCount || 0)) {
      mostInstalledBox = c;
    }
  });

  return {
    user: {
      displayName: currentUser.displayName,
      email: currentUser.email,
      createdAt: me.createdAt || null,
    },
    library: {
      ownCount: myOwn.length,
      linkedCount: linked.length,
      totalCards,
    },
    learning: {
      seen, correct, wrong,
      accuracy,
      currentStreak,
      longestStreak,
      topBox,
      topBoxSeen,
      last7,
      dueToday,
      retention,
      learningSinceDays,
      topMastery,
      weakMastery,
      hardestCards,
    },
    community: {
      publishedCount: published.length,
      totalInstalls,
      mostInstalledBox,
    },
  };
}

/* ---------- ownership-helpers ---------- */

function requireUser() {
  if (!currentUser) throw new Error("Nicht angemeldet");
  return currentUser;
}

function isOwnerOf(categoryId) {
  const cat = cache.categories[categoryId];
  return !!(cat && currentUser && cat.ownerId === currentUser.uid);
}

// Bearbeiten erlaubt: eigene Box ODER veröffentlichte Box (Wiki-Modus).
function canEditBox(categoryId) {
  const cat = cache.categories[categoryId];
  if (!cat || !currentUser) return false;
  return cat.ownerId === currentUser.uid || cat.published === true;
}

function auditPatch() {
  const u = requireUser();
  return {
    lastModifiedBy: { uid: u.uid, displayName: u.displayName || "" },
    lastModifiedAt: Date.now(),
  };
}

/* ---------- SRS (SM-2 Light) ---------- */

const SRS_DEFAULTS = Object.freeze({
  ease: 2.5,
  interval: 0,
  repetitions: 0,
  dueAt: 0,
});

function progressWithDefaults(p) {
  return {
    seen: (p && p.seen) || 0,
    correct: (p && p.correct) || 0,
    wrong: (p && p.wrong) || 0,
    lastReviewed: (p && p.lastReviewed) || 0,
    ease: (p && typeof p.ease === "number") ? p.ease : SRS_DEFAULTS.ease,
    interval: (p && typeof p.interval === "number") ? p.interval : SRS_DEFAULTS.interval,
    repetitions: (p && typeof p.repetitions === "number") ? p.repetitions : SRS_DEFAULTS.repetitions,
    dueAt: (p && typeof p.dueAt === "number") ? p.dueAt : SRS_DEFAULTS.dueAt,
  };
}

function srsNext(prev, correct) {
  let { ease, interval, repetitions } = prev;
  if (!correct) {
    repetitions = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 3;
    else interval = Math.max(1, Math.round(interval * ease));
    ease = ease + 0.1;
  }
  return {
    ease: Math.round(ease * 100) / 100,
    interval,
    repetitions,
    dueAt: Date.now() + interval * DAY_MS,
  };
}

/* ---------- public API ---------- */

const Store = {
  /* --- Auth --- */
  getCurrentUser() { return currentUser; },

  authReady() { return _authReady; },

  onAuthChange(callback) {
    authListeners.add(callback);
    callback(currentUser);
    return () => authListeners.delete(callback);
  },

  async register(email, password, displayName) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const name = (displayName || "").trim() || email.split("@")[0];
    try { await updateProfile(cred.user, { displayName: name }); } catch (e) {}
    await set(ref(db, `users/${cred.user.uid}`), {
      displayName: name,
      createdAt: Date.now(),
      longestStreak: 0,
    });
    // onAuthStateChanged feuerte direkt nach createUser mit leerem displayName –
    // jetzt steht der echte Name in der DB, also synchronisieren wir currentUser
    // sofort, damit die UI nicht den Email-Prefix anzeigt.
    if (currentUser && currentUser.uid === cred.user.uid) {
      currentUser = { ...currentUser, displayName: name };
      notifyAuth();
      notify();
    }
    return cred.user;
  },

  async login(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },

  async logout() {
    await signOut(auth);
  },

  /* --- Boxen --- */
  async getCategories() {
    return Object.values(cache.categories).sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCategory(id) {
    return cache.categories[id] || null;
  },

  async getLibraryBoxes() {
    if (!currentUser) return [];
    const libIds = new Set(Object.keys(cache.userLibrary || {}));
    return Object.values(cache.categories)
      .filter((c) => c && (c.ownerId === currentUser.uid || libIds.has(c.id)))
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async getPublishedBoxes() {
    return Object.values(cache.categories)
      .filter((c) => c && c.published)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  isOwner(categoryId) { return isOwnerOf(categoryId); },

  isInLibrary(categoryId) {
    if (!currentUser) return false;
    if (isOwnerOf(categoryId)) return true;
    return !!cache.userLibrary[categoryId];
  },

  async addCategory(name, color) {
    const user = requireUser();
    const cat = {
      id: uid("cat"),
      name: (name || "").trim() || "Neue Box",
      color: color || "#8b5cf6",
      ownerId: user.uid,
      published: false,
      description: "",
      installCount: 0,
      createdAt: Date.now(),
    };
    cache.categories[cat.id] = cat;
    notify();
    await set(ref(db, `categories/${cat.id}`), cat);
    return cat;
  },

  async updateCategory(id, patch) {
    const user = requireUser();
    const current = cache.categories[id];
    if (!current) return null;
    const isOwner = current.ownerId === user.uid;
    const canEdit = isOwner || current.published === true;
    if (!canEdit) throw new Error("Diese Box ist schreibgeschützt");

    const allowedAll = ["name", "color", "description"];
    const allowedOwner = ["published"];
    const cleanPatch = {};
    for (const k of allowedAll) if (k in patch) cleanPatch[k] = patch[k];
    if (isOwner) for (const k of allowedOwner) if (k in patch) cleanPatch[k] = patch[k];
    Object.assign(cleanPatch, auditPatch());

    const next = { ...current, ...cleanPatch };
    cache.categories[id] = next;
    notify();
    await update(ref(db, `categories/${id}`), cleanPatch);
    return next;
  },

  async publishCategory(id, description) {
    return Store.updateCategory(id, {
      published: true,
      description: (description || "").trim(),
    });
  },

  async unpublishCategory(id) {
    return Store.updateCategory(id, { published: false });
  },

  async deleteCategory(id) {
    if (!isOwnerOf(id)) throw new Error("Nur der Ersteller darf diese Box löschen");
    const cat = cache.categories[id];
    if (cat && cat.published) {
      throw new Error("Diese Box ist im Shop veröffentlicht und kann nicht gelöscht werden. Entferne sie zuerst aus dem Shop.");
    }
    const updates = {};
    updates[`categories/${id}`] = null;
    Object.values(cache.cards).forEach((card) => {
      if (card && card.categoryId === id) updates[`cards/${card.id}`] = null;
    });
    delete cache.categories[id];
    Object.keys(cache.cards).forEach((k) => {
      if (cache.cards[k] && cache.cards[k].categoryId === id) delete cache.cards[k];
    });
    notify();
    await update(ref(db), updates);
  },

  /* --- Bibliothek (Verknüpfung) --- */
  async addToLibrary(categoryId) {
    const user = requireUser();
    const cat = cache.categories[categoryId];
    if (!cat || !cat.published) throw new Error("Box nicht verfügbar");
    if (cat.ownerId === user.uid) return; // eigene Box ist immer in der Bibliothek

    if (cache.userLibrary[categoryId]) return; // schon drin
    cache.userLibrary[categoryId] = true;
    notify();
    await set(ref(db, `userLibrary/${user.uid}/${categoryId}`), true);
    await runTransaction(ref(db, `categories/${categoryId}/installCount`),
      (v) => (typeof v === "number" ? v : 0) + 1);
  },

  async removeFromLibrary(categoryId) {
    const user = requireUser();
    const cat = cache.categories[categoryId];
    if (!cat) return;

    if (cat.ownerId === user.uid) {
      // eigene Box -> komplett löschen
      return Store.deleteCategory(categoryId);
    }
    delete cache.userLibrary[categoryId];
    notify();
    await remove(ref(db, `userLibrary/${user.uid}/${categoryId}`));
    await runTransaction(ref(db, `categories/${categoryId}/installCount`),
      (v) => Math.max(0, (typeof v === "number" ? v : 0) - 1));
  },

  /* --- Karten --- */
  async getCards(categoryId) {
    const all = Object.values(cache.cards).filter(Boolean);
    const list = categoryId ? all.filter((c) => c.categoryId === categoryId) : all;
    return list
      .map((c) => ({
        ...c,
        progress: progressWithDefaults(cache.userProgress[c.id]),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCard(id) {
    const c = cache.cards[id];
    if (!c) return null;
    return {
      ...c,
      progress: progressWithDefaults(cache.userProgress[id]),
    };
  },

  async addCard(categoryId, front, back) {
    requireUser();
    if (!canEditBox(categoryId)) throw new Error("Diese Box ist schreibgeschützt");
    const card = {
      id: uid("card"),
      categoryId,
      front: (front || "").trim(),
      back: (back || "").trim(),
      createdAt: Date.now(),
    };
    cache.cards[card.id] = card;
    const audit = auditPatch();
    cache.categories[categoryId] = { ...cache.categories[categoryId], ...audit };
    notify();
    const updates = {};
    updates[`cards/${card.id}`] = card;
    updates[`categories/${categoryId}/lastModifiedBy`] = audit.lastModifiedBy;
    updates[`categories/${categoryId}/lastModifiedAt`] = audit.lastModifiedAt;
    await update(ref(db), updates);
    return card;
  },

  async addCardsBatch(categoryId, items) {
    requireUser();
    if (!canEditBox(categoryId)) throw new Error("Diese Box ist schreibgeschützt");
    const created = [];
    const updates = {};
    for (const it of items) {
      const front = (it && it.front || "").trim();
      const back = (it && it.back || "").trim();
      if (!front && !back) continue;
      const card = {
        id: uid("card"),
        categoryId,
        front,
        back,
        createdAt: Date.now(),
      };
      cache.cards[card.id] = card;
      updates[`cards/${card.id}`] = card;
      created.push(card);
    }
    if (created.length === 0) return [];
    const audit = auditPatch();
    cache.categories[categoryId] = { ...cache.categories[categoryId], ...audit };
    updates[`categories/${categoryId}/lastModifiedBy`] = audit.lastModifiedBy;
    updates[`categories/${categoryId}/lastModifiedAt`] = audit.lastModifiedAt;
    notify();
    await update(ref(db), updates);
    return created;
  },

  async updateCard(id, patch) {
    requireUser();
    const current = cache.cards[id];
    if (!current) return null;
    if (!canEditBox(current.categoryId)) throw new Error("Diese Karte ist schreibgeschützt");
    const allowed = ["front", "back"];
    const cleanPatch = {};
    for (const k of allowed) if (k in patch) cleanPatch[k] = patch[k];
    const next = { ...current, ...cleanPatch };
    cache.cards[id] = next;
    const audit = auditPatch();
    cache.categories[current.categoryId] = { ...cache.categories[current.categoryId], ...audit };
    notify();
    const updates = {};
    Object.entries(cleanPatch).forEach(([k, v]) => { updates[`cards/${id}/${k}`] = v; });
    updates[`categories/${current.categoryId}/lastModifiedBy`] = audit.lastModifiedBy;
    updates[`categories/${current.categoryId}/lastModifiedAt`] = audit.lastModifiedAt;
    await update(ref(db), updates);
    return next;
  },

  async deleteCard(id) {
    requireUser();
    const current = cache.cards[id];
    if (!current) return;
    if (!canEditBox(current.categoryId)) throw new Error("Diese Karte ist schreibgeschützt");
    delete cache.cards[id];
    const audit = auditPatch();
    cache.categories[current.categoryId] = { ...cache.categories[current.categoryId], ...audit };
    notify();
    const updates = {};
    updates[`cards/${id}`] = null;
    updates[`categories/${current.categoryId}/lastModifiedBy`] = audit.lastModifiedBy;
    updates[`categories/${current.categoryId}/lastModifiedAt`] = audit.lastModifiedAt;
    await update(ref(db), updates);
  },

  /* --- Lernen --- */
  canEdit(categoryId) { return canEditBox(categoryId); },

  async recordAnswer(cardId, correct) {
    const user = requireUser();
    const card = cache.cards[cardId];
    if (!card) return null;
    const prev = progressWithDefaults(cache.userProgress[cardId]);
    const srs = srsNext(prev, correct);
    const progress = {
      seen:    prev.seen + 1,
      correct: prev.correct + (correct ? 1 : 0),
      wrong:   prev.wrong + (correct ? 0 : 1),
      lastReviewed: Date.now(),
      ease: srs.ease,
      interval: srs.interval,
      repetitions: srs.repetitions,
      dueAt: srs.dueAt,
    };
    cache.userProgress[cardId] = progress;
    notify();
    await set(ref(db, `userProgress/${user.uid}/${cardId}`), progress);

    // Streak-Rekord ggf. aktualisieren
    const newStreak = computeCurrentStreak(cache.userProgress);
    const me = cache.users[user.uid] || {};
    if (newStreak > (me.longestStreak || 0)) {
      await update(ref(db, `users/${user.uid}`), { longestStreak: newStreak });
    }
    return { ...card, progress };
  },

  /* --- Profil --- */
  async getProfileStats() {
    return buildProfileStats();
  },

  async getPublicProfileStats(uid) {
    return buildPublicProfileStats(uid);
  },

  async getBoxStats(categoryId) {
    return buildBoxStatsForCurrentUser(categoryId);
  },

  async updateDisplayName(newName) {
    const user = requireUser();
    const n = String(newName == null ? "" : newName).trim();
    if (!n) throw new Error("Anzeigename darf nicht leer sein");
    if (n.length > 40) throw new Error("Anzeigename ist zu lang (max. 40 Zeichen)");
    if (cache.users[user.uid] && cache.users[user.uid].displayName === n) {
      return n; // nichts zu tun
    }
    await update(ref(db, `users/${user.uid}`), { displayName: n });
    currentUser = { ...currentUser, displayName: n };
    if (cache.users[user.uid]) {
      cache.users[user.uid] = { ...cache.users[user.uid], displayName: n };
    }
    try { await updateProfile(auth.currentUser, { displayName: n }); } catch (e) {}
    notifyAuth();
    notify();
    return n;
  },

  getUser(uid) { return cache.users[uid] || null; },

  getAllUsers() {
    return Object.entries(cache.users || {})
      .map(([uid, u]) => ({ uid, ...u }))
      .filter((u) => u && u.displayName);
  },

  /* --- Subscriptions --- */
  subscribe(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
};

window.Store = Store;
export default Store;
