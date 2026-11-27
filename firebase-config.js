/*
 * Live shared database settings (Firebase).
 * Leave apiKey as "PASTE_..." to keep using data.json / browser storage instead.
 * See README.md → "Live shared database (Firebase)" for the 10-minute setup.
 *
 * These values are not secret: they only identify your Firebase project.
 * The data is protected by staff sign-in and the security rules in firestore.rules.
 */
window.FIREBASE_CONFIG = {
 apiKey: "AIzaSyAfa4vcklC8hmeNeBHrug_TxRcj1obTP9Y",
  authDomain: "nelc2026-attendancesystem.firebaseapp.com",
  projectId: "nelc2026-attendancesystem",
  storageBucket: "nelc2026-attendancesystem.firebasestorage.app",
  messagingSenderId: "393486613665",
  appId: "1:393486613665:web:ede88a13fbf3bd698dc4e0"
};

// One database can hold several events; change this for a new event to start with an empty list.
window.EVENT_ID = "nelc-2026";
