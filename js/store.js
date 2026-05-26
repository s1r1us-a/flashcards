/* =============================================================================
 * Flashcards – Data Access Layer
 *
 * Exposes a single global `Store` with a promise-based API. The current
 * implementation persists to `localStorage`. The API mirrors what a Firebase
 * Realtime DB layer would offer so the upgrade is a one-line swap below.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FIREBASE PLACEHOLDER
 *
 * To switch to Firebase Realtime DB later:
 *   1. Include Firebase SDK scripts in index.html (see the comment block there).
 *   2. Fill in `firebaseConfig` below.
 *   3. At the bottom of this file change:
 *        window.Store = LocalStore;
 *      to:
 *        window.Store = FirebaseStore;
 *
 * The `FirebaseStore` skeleton at the bottom of this file already has the
 * same method signatures – only the bodies need to be implemented.
 * ────────────────────────────────────────────────────────────────────────────
 */

const firebaseConfig = {
  // apiKey:        "",
  // authDomain:    "",
  // databaseURL:   "",
  // projectId:     "",
  // storageBucket: "",
  // appId:         "",
};

const STORAGE_KEY = "flashcards_v1";

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function emptyState() {
  return { categories: [], cards: [] };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
    };
  } catch (err) {
    console.warn("[Store] Failed to parse localStorage – resetting.", err);
    return emptyState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ----------------------------------------------------------------------------
 * LocalStore – default implementation
 * -------------------------------------------------------------------------- */

const LocalStore = (() => {
  let state = loadState();
  const listeners = new Set();

  function commit() {
    saveState(state);
    listeners.forEach((cb) => {
      try { cb(state); } catch (err) { console.error(err); }
    });
  }

  return {
    async getCategories() {
      return state.categories.slice().sort((a, b) => a.createdAt - b.createdAt);
    },

    async getCategory(id) {
      return state.categories.find((c) => c.id === id) || null;
    },

    async addCategory(name, color) {
      const cat = {
        id: uid("cat"),
        name: name.trim() || "Neue Box",
        color: color || "#8b5cf6",
        createdAt: Date.now(),
      };
      state.categories.push(cat);
      commit();
      return cat;
    },

    async updateCategory(id, patch) {
      const cat = state.categories.find((c) => c.id === id);
      if (!cat) return null;
      Object.assign(cat, patch);
      commit();
      return cat;
    },

    async deleteCategory(id) {
      state.categories = state.categories.filter((c) => c.id !== id);
      state.cards = state.cards.filter((c) => c.categoryId !== id);
      commit();
    },

    async getCards(categoryId) {
      const list = categoryId
        ? state.cards.filter((c) => c.categoryId === categoryId)
        : state.cards.slice();
      return list.sort((a, b) => a.createdAt - b.createdAt);
    },

    async getCard(id) {
      return state.cards.find((c) => c.id === id) || null;
    },

    async addCard(categoryId, front, back) {
      const card = {
        id: uid("card"),
        categoryId,
        front: (front || "").trim(),
        back: (back || "").trim(),
        progress: { seen: 0, correct: 0, wrong: 0, lastReviewed: null },
        createdAt: Date.now(),
      };
      state.cards.push(card);
      commit();
      return card;
    },

    async updateCard(id, patch) {
      const card = state.cards.find((c) => c.id === id);
      if (!card) return null;
      Object.assign(card, patch);
      commit();
      return card;
    },

    async deleteCard(id) {
      state.cards = state.cards.filter((c) => c.id !== id);
      commit();
    },

    async recordAnswer(cardId, correct) {
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) return null;
      card.progress.seen += 1;
      if (correct) card.progress.correct += 1;
      else card.progress.wrong += 1;
      card.progress.lastReviewed = Date.now();
      commit();
      return card;
    },

    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
})();

/* ----------------------------------------------------------------------------
 * FirebaseStore – stub. Same signatures, empty bodies.
 *
 * Once Firebase is wired up, implement these using
 *   firebase.database().ref('categories'), .ref('cards'), etc.
 * and replace the export at the bottom of this file.
 * -------------------------------------------------------------------------- */

/* eslint-disable no-unused-vars */
const FirebaseStore = {
  async getCategories() {
    // const snap = await firebase.database().ref('categories').once('value');
    // return Object.values(snap.val() || {});
    throw new Error("FirebaseStore not yet implemented");
  },
  async getCategory(id) { throw new Error("FirebaseStore not yet implemented"); },
  async addCategory(name, color) { throw new Error("FirebaseStore not yet implemented"); },
  async updateCategory(id, patch) { throw new Error("FirebaseStore not yet implemented"); },
  async deleteCategory(id) { throw new Error("FirebaseStore not yet implemented"); },
  async getCards(categoryId) { throw new Error("FirebaseStore not yet implemented"); },
  async getCard(id) { throw new Error("FirebaseStore not yet implemented"); },
  async addCard(categoryId, front, back) { throw new Error("FirebaseStore not yet implemented"); },
  async updateCard(id, patch) { throw new Error("FirebaseStore not yet implemented"); },
  async deleteCard(id) { throw new Error("FirebaseStore not yet implemented"); },
  async recordAnswer(cardId, correct) { throw new Error("FirebaseStore not yet implemented"); },
  subscribe(callback) {
    // const ref = firebase.database().ref('/');
    // const handler = (snap) => callback(snap.val());
    // ref.on('value', handler);
    // return () => ref.off('value', handler);
    return () => {};
  },
};
/* eslint-enable no-unused-vars */

/* ----------------------------------------------------------------------------
 * Export the active store. Switch the assignment when Firebase is ready.
 * -------------------------------------------------------------------------- */

window.Store = LocalStore;
// window.Store = FirebaseStore;
