# Flashcards

Eine moderne Karteikarten-Webapp mit Glassmorphism-Design. Vanilla HTML/CSS/JS, keine Build-Tools, keine Dependencies.

## Features

- **Boxen mit Kategorien** – Organisiere Karten in farbigen Themen-Boxen
- **Flip-Animation** – Karten drehen sich elegant in 3D
- **Lernmodus** – Karten in zufälliger Reihenfolge durchgehen, Fortschritt und Quote werden gespeichert
- **Suche & Filter** – Boxen und Karten in Echtzeit durchsuchen
- **Glassmorphism Dark** – Animierter Hintergrund, transparente Karten mit Blur
- **Responsive** – funktioniert auf Desktop und Mobile
- **Persistenz** – Daten werden lokal im Browser (localStorage) gespeichert

## Starten

Einfach `index.html` im Browser öffnen. Kein Server nötig.

Optional mit lokalem Server (z. B. für saubere Pfade):

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Struktur

```
/
├── index.html        Markup
├── css/styles.css    Styling, Flip-Animation, Glassmorphism
├── js/store.js       Datenzugriffs-Layer (LocalStore + Firebase-Stub)
└── js/app.js         UI-Logik, Routing, Lernmodus
```

## Firebase Realtime DB aktivieren

Der Code ist vorbereitet für einen späteren Wechsel auf Firebase Realtime DB.
Aktuell läuft alles über `localStorage`.

So aktivierst du Firebase später:

1. In `index.html` die Firebase-SDK-Scripts einbinden (Kommentarblock am Ende
   des `<body>` zeigt die richtige Stelle):
   ```html
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js"></script>
   ```
2. In `js/store.js` den `firebaseConfig` mit deinen Werten füllen.
3. Die Methoden im `FirebaseStore`-Stub am Ende von `js/store.js` implementieren
   (Signaturen sind identisch zu `LocalStore`).
4. Den Export-Zeile am Ende der Datei tauschen:
   ```js
   // window.Store = LocalStore;
   window.Store = FirebaseStore;
   ```

Die UI bleibt unverändert – sie spricht nur `Store` an.

## Tastatur-Shortcuts

- **Leertaste / Enter** im Lernmodus: Karte umdrehen
- **← / 1**: Antwort als "falsch" markieren
- **→ / 2**: Antwort als "richtig" markieren
- **Esc**: Modal schließen
