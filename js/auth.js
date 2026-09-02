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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  setBusy(true);

  const email = emailInput.value.trim();
  const password = passwordInput.value;

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

    if (
      code === "auth/invalid-credential" ||
      code === "auth/wrong-password" ||
      code === "auth/user-not-found"
    ) {
      showError("Incorrect email or password.");
    } else if (code === "auth/too-many-requests") {
      showError(
        "Too many failed attempts. Please wait a few minutes and try again.",
      );
    } else {
      showError("Something went wrong signing in. Please try again.");
      console.error(err);
    }
  }
});
