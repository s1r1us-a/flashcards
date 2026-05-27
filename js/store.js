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

/* ---------- globale Listener (lesen für alle erlaubt) ---------- */

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
  notify();
}, (err) => console.error("[Store] users read failed", err));

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
    currentUser = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || (user.email || "").split("@")[0],
    };
    attachUserListeners(user.uid);
  } else {
    currentUser = null;
  }
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
  Object.entries(cache.userProgress || {}).forEach(([cardId, p]) => {
    if (!p) return;
    seen    += p.seen    || 0;
    correct += p.correct || 0;
    wrong   += p.wrong   || 0;
    const card = cache.cards[cardId];
    if (card) {
      seenByBox[card.categoryId] = (seenByBox[card.categoryId] || 0) + (p.seen || 0);
    }
  });
  const accuracy = seen ? Math.round((correct / seen) * 100) : null;
  const currentStreak = computeCurrentStreak(cache.userProgress);
  const longestStreak = Math.max(me.longestStreak || 0, currentStreak);

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

/* ---------- public API ---------- */

const Store = {
  /* --- Auth --- */
  getCurrentUser() { return currentUser; },

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
    if (!isOwnerOf(id)) throw new Error("Nur der Ersteller darf diese Box ändern");
    const current = cache.categories[id];
    if (!current) return null;
    const allowed = ["name", "color", "description", "published"];
    const cleanPatch = {};
    for (const k of allowed) if (k in patch) cleanPatch[k] = patch[k];
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
        progress: cache.userProgress[c.id]
          || { seen: 0, correct: 0, wrong: 0, lastReviewed: 0 },
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCard(id) {
    const c = cache.cards[id];
    if (!c) return null;
    return {
      ...c,
      progress: cache.userProgress[id]
        || { seen: 0, correct: 0, wrong: 0, lastReviewed: 0 },
    };
  },

  async addCard(categoryId, front, back) {
    if (!isOwnerOf(categoryId)) throw new Error("Diese Box ist schreibgeschützt");
    const card = {
      id: uid("card"),
      categoryId,
      front: (front || "").trim(),
      back: (back || "").trim(),
      createdAt: Date.now(),
    };
    cache.cards[card.id] = card;
    notify();
    await set(ref(db, `cards/${card.id}`), card);
    return card;
  },

  async updateCard(id, patch) {
    const current = cache.cards[id];
    if (!current) return null;
    if (!isOwnerOf(current.categoryId)) throw new Error("Diese Karte ist schreibgeschützt");
    const allowed = ["front", "back"];
    const cleanPatch = {};
    for (const k of allowed) if (k in patch) cleanPatch[k] = patch[k];
    const next = { ...current, ...cleanPatch };
    cache.cards[id] = next;
    notify();
    await update(ref(db, `cards/${id}`), cleanPatch);
    return next;
  },

  async deleteCard(id) {
    const current = cache.cards[id];
    if (!current) return;
    if (!isOwnerOf(current.categoryId)) throw new Error("Diese Karte ist schreibgeschützt");
    delete cache.cards[id];
    notify();
    await remove(ref(db, `cards/${id}`));
  },

  /* --- Lernen --- */
  async recordAnswer(cardId, correct) {
    const user = requireUser();
    const card = cache.cards[cardId];
    if (!card) return null;
    const prev = cache.userProgress[cardId] || { seen: 0, correct: 0, wrong: 0, lastReviewed: 0 };
    const progress = {
      seen:    (prev.seen    || 0) + 1,
      correct: (prev.correct || 0) + (correct ? 1 : 0),
      wrong:   (prev.wrong   || 0) + (correct ? 0 : 1),
      lastReviewed: Date.now(),
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

  getUser(uid) { return cache.users[uid] || null; },

  /* --- Subscriptions --- */
  subscribe(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
};

window.Store = Store;
export default Store;
