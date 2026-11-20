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
  push,
  remove,
  runTransaction,
  serverTimestamp,
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

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 2 * 60 * 1000; // 2 minutes
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COMMON_TLDS = new Set([
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "mil",
  "int",
  "info",
  "biz",
  "co",
  "io",
  "me",
  "dev",
  "app",
  "ph",
  "us",
  "uk",
  "ca",
  "au",
  "nz",
  "sg",
  "in",
  "jp",
  "cn",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "se",
  "no",
  "dk",
  "fi",
  "ru",
  "br",
  "mx",
  "ke",
  "za",
]);
// Extend this list if a legitimate admin email uses a TLD not covered here.

function hasValidTld(email) {
  const domain = email.split("@")[1] || "";
  const parts = domain.split(".");
  if (parts.length < 2) return false;
  return COMMON_TLDS.has(parts[parts.length - 1].toLowerCase());
}

// Firebase RTDB keys can't contain . # $ [ ] /
function sanitizeEmailKey(email) {
  return email.toLowerCase().replace(/[.#$[\]/]/g, ",");
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}${seconds > 0 ? ` ${seconds}s` : ""}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function buildLockoutMessage(lockedUntil) {
  return `Too many failed attempts. This account is temporarily locked. Please try again in ${formatRemaining(lockedUntil - Date.now())}.`;
}

// Atomically bumps the fail count for this email and locks it once the
// threshold is hit. Runs unauthenticated (the user hasn't signed in yet),
// so loginAttempts/* in the DB rules must allow unauthenticated read/write —
// same as the mobile app's existing lockout node.
async function registerFailedAttempt(key) {
  const attemptRef = ref(db, `loginAttempts/${key}`);
  const result = await runTransaction(attemptRef, (current) => {
    const now = Date.now();
    const failCount = (current?.failCount || 0) + 1;
    return failCount >= MAX_FAILED_ATTEMPTS
      ? { failCount, lockedUntil: now + LOCKOUT_DURATION_MS }
      : { failCount, lockedUntil: current?.lockedUntil || null };
  });
  return result.snapshot.val();
}

async function clearLoginAttempts(key) {
  try {
    await remove(ref(db, `loginAttempts/${key}`));
  } catch {
    // non-fatal — a leftover attempts node just means the next failed
    // login (if any) starts counting from a stale base
  }
}

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

let lockoutIntervalId = null;

function stopLockoutCountdown() {
  if (lockoutIntervalId) {
    clearInterval(lockoutIntervalId);
    lockoutIntervalId = null;
  }
}

function startLockoutCountdown(lockedUntil) {
  stopLockoutCountdown();
  submitBtn.textContent = "Sign in";
  submitBtn.disabled = true;

  const tick = () => {
    const remaining = lockedUntil - Date.now();
    if (remaining <= 0) {
      stopLockoutCountdown();
      hideError();
      submitBtn.disabled = false;
      return;
    }
    showError(buildLockoutMessage(lockedUntil));
  };

  tick();
  lockoutIntervalId = setInterval(tick, 1000);
}

// Records a successful admin sign-in to the audit trail. Runs AFTER the
// admin allowlist check has already passed, so the write satisfies the
// activityLogs rule's admin branch. A failed log must never block the
// admin from actually getting into the dashboard.
async function logAdminSignIn(uid, email) {
  try {
    await push(ref(db, "activityLogs"), {
      actorUid: uid,
      actorName: email || "Admin",
      actorRole: "admin",
      activityType: "ADMIN_LOGIN",
      category: "Admin Action",
      description: `${email || "An admin"} signed in`,
      status: "Signed in",
      severity: "info",
      timestamp: serverTimestamp(),
      platform: "web-admin",
    });
  } catch (err) {
    console.error("Couldn't write ADMIN_LOGIN audit log:", err);
  }
}

// NEW
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  stopLockoutCountdown();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email && !password) {
    showError("Please enter your email and password.");
    return;
  }
  if (!email) {
    showError("Please enter your email.");
    emailInput.focus();
    return;
  }
  if (!EMAIL_REGEX.test(email) || !hasValidTld(email)) {
    showError("Please enter a valid email address.");
    emailInput.focus();
    return;
  }
  if (!password) {
    showError("Please enter your password.");
    passwordInput.focus();
    return;
  }

  const key = sanitizeEmailKey(email);
  setBusy(true);

  // Lockout check BEFORE spending a Firebase auth attempt
  try {
    const attemptSnap = await get(ref(db, `loginAttempts/${key}`));
    const state = attemptSnap.exists() ? attemptSnap.val() : null;
    if (state?.lockedUntil && state.lockedUntil > Date.now()) {
      setBusy(false);
      startLockoutCountdown(state.lockedUntil);
      return;
    }
  } catch (err) {
    console.error("Couldn't check lockout state:", err);
    // don't block sign-in just because the lockout check failed
  }

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    const adminSnap = await get(ref(db, `admins/${uid}`));

    if (!adminSnap.exists() || adminSnap.val() !== true) {
      await signOut(auth);
      showError(
        "This account is not authorized as an admin. Contact the project owner if you believe this is a mistake.",
      );
      setBusy(false);
      return;
    }

    await clearLoginAttempts(key);
    stopLockoutCountdown();
    await logAdminSignIn(uid, cred.user.email);
    window.location.href = "dashboard.html";
  } catch (err) {
    setBusy(false);
    const code = err?.code || "";

    const isBadCredential =
      code === "auth/invalid-credential" ||
      code === "auth/wrong-password" ||
      code === "auth/user-not-found";

    if (code === "auth/invalid-email") {
      showError("Please enter a valid email address.");
    } else if (
      code === "auth/missing-password" ||
      code === "auth/missing-email"
    ) {
      showError("Please enter your email and password.");
    } else if (isBadCredential) {
      try {
        const updated = await registerFailedAttempt(key);
        if (updated?.lockedUntil && updated.lockedUntil > Date.now()) {
          startLockoutCountdown(updated.lockedUntil);
        } else {
          showError("Invalid email or password.");
        }
      } catch (lockoutErr) {
        console.error("Couldn't record failed attempt:", lockoutErr);
        showError("Invalid email or password.");
      }
    } else if (code === "auth/too-many-requests") {
      showError(
        "Too many failed attempts. Please wait a few minutes and try again.",
      );
    } else if (code === "auth/network-request-failed") {
      showError("Network error — check your connection and try again.");
    } else {
      showError(
        "Something went wrong on our end. Please try again in a moment.",
      );
      console.error(err);
    }
  }
});
