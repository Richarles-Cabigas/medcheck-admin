import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { firebaseConfig } from "./firebase-init.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const errorBox = document.getElementById("login-error");
const submitBtn = document.getElementById("login-submit");
const togglePasswordBtn = document.getElementById("toggle-password");
const togglePasswordIcon = document.getElementById("toggle-password-icon");

// Feather-style "eye" / "eye-off" icon paths, swapped in place so we
// don't need an icon font or external asset just for this toggle.
const EYE_ICON = `
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/>
  <circle cx="12" cy="12" r="3"/>
`;
const EYE_OFF_ICON = `
  <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.77 21.77 0 0 1 5.06-6.06"/>
  <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-2.16 3.19"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
`;

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("visible");
}

function hideError() {
  errorBox.classList.remove("visible");
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.textContent = busy ? "Signing in…" : "Sign in";
}

// ── Show/hide password ──────────────────────────────────────────────
togglePasswordBtn.addEventListener("click", () => {
  const showingPassword = passwordInput.type === "password";
  passwordInput.type = showingPassword ? "text" : "password";
  togglePasswordBtn.setAttribute(
    "aria-label",
    showingPassword ? "Hide password" : "Show password",
  );
  togglePasswordIcon.innerHTML = showingPassword ? EYE_OFF_ICON : EYE_ICON;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  // Client-side check first — without this, an empty password gets
  // sent straight to Firebase and comes back as an unhelpful generic
  // error instead of telling the admin what's actually missing.
  if (!email && !password) {
    showError("Please enter your email and password.");
    return;
  }
  if (!email) {
    showError("Please enter your email.");
    emailInput.focus();
    return;
  }
  if (!password) {
    showError("Please enter your password.");
    passwordInput.focus();
    return;
  }

  setBusy(true);

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    // Check the admin allowlist
    const adminSnap = await get(ref(db, `admins/${uid}`));

    if (!adminSnap.exists() || adminSnap.val() !== true) {
      await signOut(auth);
      showError(
        "This account is not authorized as an admin. Contact the project owner if you believe this is a mistake.",
      );
      setBusy(false);
      return;
    }

    // Authorized — go to the dashboard
    window.location.href = "dashboard.html";
  } catch (err) {
    setBusy(false);
    const code = err?.code || "";

    if (code === "auth/invalid-email") {
      showError("That email address doesn't look right.");
    } else if (
      code === "auth/missing-password" ||
      code === "auth/missing-email"
    ) {
      showError("Please enter your email and password.");
    } else if (
      code === "auth/invalid-credential" ||
      code === "auth/wrong-password" ||
      code === "auth/user-not-found"
    ) {
      showError("Incorrect email or password.");
    } else if (code === "auth/too-many-requests") {
      showError(
        "Too many failed attempts. Please wait a few minutes and try again.",
      );
    } else if (code === "auth/network-request-failed") {
      showError("Network error — check your connection and try again.");
    } else {
      showError("Something went wrong signing in. Please try again.");
      console.error(err);
    }
  }
});
