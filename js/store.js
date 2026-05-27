/* =============================================================================
 * Flashcards – Data Access Layer
 * Backed by Firebase Realtime Database with per-user data isolation.
 * ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getDatabase, ref, onValue, set, update, remove,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence,
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

const cache = { categories: {}, cards: {} };
const dataListeners = new Set();
const authListeners = new Set();
let ready = { categories: false, cards: false };
let currentUser = null;
let unsubCategories = null;
let unsubCards = null;

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

function userPath(suffix) {
  if (!currentUser) throw new Error("Nicht eingeloggt");
  return `users/${currentUser.uid}/${suffix}`;
}

function detachDataListeners() {
  if (unsubCategories) { unsubCategories(); unsubCategories = null; }
  if (unsubCards)      { unsubCards();      unsubCards = null; }
  cache.categories = {};
  cache.cards = {};
  ready = { categories: false, cards: false };
}

function attachDataListeners(uidStr) {
  unsubCategories = onValue(ref(db, `users/${uidStr}/categories`), (snap) => {
    cache.categories = snap.val() || {};
    ready.categories = true;
    notify();
  }, (err) => console.error("[Store] categories read failed", err));

  unsubCards = onValue(ref(db, `users/${uidStr}/cards`), (snap) => {
    cache.cards = snap.val() || {};
    ready.cards = true;
    notify();
  }, (err) => console.error("[Store] cards read failed", err));
}

onAuthStateChanged(auth, (user) => {
  detachDataListeners();
  currentUser = user || null;
  if (user) attachDataListeners(user.uid);
  notifyAuth();
  notify();
});

/* ---------- auth-error translation ---------- */

function translateAuthError(err) {
  const code = err && err.code ? err.code : "";
  switch (code) {
    case "auth/invalid-email":         return "Ungültige Email-Adresse.";
    case "auth/missing-password":      return "Bitte gib ein Passwort ein.";
    case "auth/weak-password":         return "Passwort zu schwach (mind. 6 Zeichen).";
    case "auth/email-already-in-use":  return "Diese Email ist bereits registriert.";
    case "auth/user-not-found":        return "Kein Account mit dieser Email gefunden.";
    case "auth/wrong-password":        return "Falsches Passwort.";
    case "auth/invalid-credential":    return "Email oder Passwort ist falsch.";
    case "auth/too-many-requests":     return "Zu viele Versuche – bitte später erneut probieren.";
    case "auth/network-request-failed":return "Netzwerkfehler – ist deine Verbindung aktiv?";
    default: return (err && err.message) || "Unbekannter Fehler.";
  }
}

/* ---------- public API ---------- */

const Store = {
  isReady() { return !!currentUser && ready.categories && ready.cards; },

  async getCategories() {
    return Object.values(cache.categories).sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCategory(id) {
    return cache.categories[id] || null;
  },

  async addCategory(name, color) {
    const cat = {
      id: uid("cat"),
      name: (name || "").trim() || "Neue Box",
      color: color || "#8b5cf6",
      createdAt: Date.now(),
    };
    cache.categories[cat.id] = cat;
    notify();
    await set(ref(db, userPath(`categories/${cat.id}`)), cat);
    return cat;
  },

  async updateCategory(id, patch) {
    const current = cache.categories[id];
    if (!current) return null;
    const next = { ...current, ...patch };
    cache.categories[id] = next;
    notify();
    await update(ref(db, userPath(`categories/${id}`)), patch);
    return next;
  },

  async deleteCategory(id) {
    const updates = {};
    updates[userPath(`categories/${id}`)] = null;
    Object.values(cache.cards).forEach((card) => {
      if (card.categoryId === id) updates[userPath(`cards/${card.id}`)] = null;
    });
    delete cache.categories[id];
    Object.keys(cache.cards).forEach((k) => {
      if (cache.cards[k].categoryId === id) delete cache.cards[k];
    });
    notify();
    await update(ref(db), updates);
  },

  async getCards(categoryId) {
    const all = Object.values(cache.cards);
    const list = categoryId ? all.filter((c) => c.categoryId === categoryId) : all;
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCard(id) {
    return cache.cards[id] || null;
  },

  async addCard(categoryId, front, back) {
    const card = {
      id: uid("card"),
      categoryId,
      front: (front || "").trim(),
      back: (back || "").trim(),
      progress: { seen: 0, correct: 0, wrong: 0, lastReviewed: 0 },
      createdAt: Date.now(),
    };
    cache.cards[card.id] = card;
    notify();
    await set(ref(db, userPath(`cards/${card.id}`)), card);
    return card;
  },

  async updateCard(id, patch) {
    const current = cache.cards[id];
    if (!current) return null;
    const next = { ...current, ...patch };
    cache.cards[id] = next;
    notify();
    await update(ref(db, userPath(`cards/${id}`)), patch);
    return next;
  },

  async deleteCard(id) {
    delete cache.cards[id];
    notify();
    await remove(ref(db, userPath(`cards/${id}`)));
  },

  async recordAnswer(cardId, correct) {
    const card = cache.cards[cardId];
    if (!card) return null;
    const progress = {
      seen:    (card.progress?.seen    || 0) + 1,
      correct: (card.progress?.correct || 0) + (correct ? 1 : 0),
      wrong:   (card.progress?.wrong   || 0) + (correct ? 0 : 1),
      lastReviewed: Date.now(),
    };
    cache.cards[cardId] = { ...card, progress };
    notify();
    await update(ref(db, userPath(`cards/${cardId}/progress`)), progress);
    return cache.cards[cardId];
  },

  subscribe(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },

  auth: {
    currentUser() { return currentUser; },

    onChange(cb) {
      authListeners.add(cb);
      try { cb(currentUser); } catch (e) { console.error(e); }
      return () => authListeners.delete(cb);
    },

    async login(email, password) {
      try {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } catch (err) {
        throw new Error(translateAuthError(err));
      }
    },

    async register(email, password) {
      try {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } catch (err) {
        throw new Error(translateAuthError(err));
      }
    },

    async resetPassword(email) {
      try {
        await sendPasswordResetEmail(auth, email.trim());
      } catch (err) {
        throw new Error(translateAuthError(err));
      }
    },

    async logout() {
      await signOut(auth);
    },
  },
};

window.Store = Store;
export default Store;
