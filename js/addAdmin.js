// ═══════════════════════════════════════════════════════════════════
// Standalone Add-Admin page. This file sets up its own Firebase
// connection and its own admin login guard — it does NOT rely on
// dashboard.js at all, since it's a separate HTML page.
// ═══════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  push,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { firebaseConfig } from "./firebase-init.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const API_KEY = "AIzaSyDU6v_OifaRnqhN9yr1zR0MQIvXRIkGoTs";

// Captured once the current session is confirmed as admin — used to
// stamp "created by" on both the new admin's profile and the audit log.
let currentAdminUid = null;
let currentAdminEmail = null;

// ── DOM refs ─────────────────────────────────────────────────────────
const newAdminEmail = document.getElementById("new-admin-email");
const newAdminPassword = document.getElementById("new-admin-password");
const addAdminError = document.getElementById("add-admin-error");
const addAdminSubmit = document.getElementById("add-admin-submit");
const backLink = document.getElementById("back-to-dashboard");

// ── Guard: must be signed in AND already an admin ───────────────────
// Same pattern as dashboard.js. Without this, ANYONE who finds this
// page's URL could create themselves an admin account.
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  const adminSnap = await get(ref(db, `admins/${user.uid}`));
  if (!adminSnap.exists() || adminSnap.val() !== true) {
    await signOut(auth);
    window.location.href = "index.html";
    return;
  }

  currentAdminUid = user.uid;
  currentAdminEmail = user.email;
  // Signed in AND confirmed admin — page is now usable.
});

if (backLink) {
  backLink.addEventListener("click", () => {
    window.location.href = "dashboard.html";
  });
}

// A failed log must never block the admin's real action.
async function logAdminCreated(newUid, newEmail) {
  try {
    await push(ref(db, "activityLogs"), {
      actorUid: currentAdminUid,
      actorName: currentAdminEmail || "Admin",
      actorRole: "admin",
      activityType: "ADMIN_CREATED",
      category: "Admin Action",
      description: `Created new admin account for ${newEmail}`,
      status: "Created",
      severity: "warning",
      targetUid: newUid,
      targetName: newEmail,
      timestamp: serverTimestamp(),
      platform: "web-admin",
    });
  } catch (err) {
    console.error("Couldn't write ADMIN_CREATED audit log:", err);
  }
}

// ── Create admin ─────────────────────────────────────────────────────
addAdminSubmit.addEventListener("click", async () => {
  const email = newAdminEmail.value.trim();
  const password = newAdminPassword.value;

  addAdminError.classList.remove("visible");

  if (!email || !password) {
    addAdminError.textContent = "Email and password are required.";
    addAdminError.classList.add("visible");
    return;
  }
  if (password.length < 6) {
    addAdminError.textContent = "Password must be at least 6 characters.";
    addAdminError.classList.add("visible");
    return;
  }

  addAdminSubmit.disabled = true;
  addAdminSubmit.textContent = "Creating…";

  try {
    // Step 1: create the Firebase Auth account via REST — same endpoint
    // your MAUI doctor registration uses. Doesn't require an admin
    // token; it's just "make a new login".
    const signUpRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    const signUpResult = await signUpRes.json();

    if (!signUpRes.ok) {
      const msg = signUpResult?.error?.message || "Unknown error";
      if (msg === "EMAIL_EXISTS") {
        throw new Error("An account with this email already exists.");
      }
      throw new Error(msg);
    }

    const newUid = signUpResult.localId;

    // Step 2: grant admin rights, using the CURRENTLY signed-in admin's
    // session (auth.currentUser here is YOU, not the new account) —
    // this is what the rules check to authorize the write.
    await set(ref(db, `admins/${newUid}`), true);

    // Step 3: record who this admin is and who created them, so the
    // Admins screen in the dashboard can show more than a bare UID.
    await set(ref(db, `adminProfiles/${newUid}`), {
      email,
      createdAt: Date.now(),
      createdByUid: currentAdminUid,
      createdByEmail: currentAdminEmail || "",
    });

    // Step 4: audit log — this is the kind of action that should always
    // leave a trail, not optionally.
    await logAdminCreated(newUid, email);

    newAdminEmail.value = "";
    newAdminPassword.value = "";
    addAdminSubmit.textContent = "Created ✓";
    setTimeout(() => {
      addAdminSubmit.textContent = "Create admin account";
    }, 2000);
  } catch (err) {
    console.error(err);
    addAdminError.textContent = err.message || "Something went wrong.";
    addAdminError.classList.add("visible");
  } finally {
    addAdminSubmit.disabled = false;
  }
});
