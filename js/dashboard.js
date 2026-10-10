// ═══════════════════════════════════════════════════════════════════
// Dashboard logic.
//
// Data model this reads/writes (all under the flat root, same place
// MedCheck's mobile app already stores every user — patient, doctor,
// caregiver — keyed by uid):
//
//   /{uid}/role                → "doctor"
//   /{uid}/name                → "Dr. Juan Dela Cruz"
//   /{uid}/licenseNumber       → "1234567"   (also duplicated as prcNumber)
//   /{uid}/specialization      → "Cardiology, Pediatrics"
//   /{uid}/phone               → "+639123456789"
//   /{uid}/email               → "doctor@email.com"
//   /{uid}/prcIdImageUrl       → full Firebase Storage download URL
//   /{uid}/verificationStatus  → "Pending" | "Verified" | "Rejected"
//   /{uid}/registeredAt        → unix ms   (added alongside this feature)
//   /{uid}/reviewedBy          → admin uid (written here)
//   /{uid}/reviewedByEmail     → admin email, for readability
//   /{uid}/reviewedAt          → unix ms   (written here)
//   /{uid}/rejectionReason     → string, only present when Rejected
//
//   /admins/{uid} = true       → admin allowlist (checked in auth.js)
//
// Firebase Realtime Database can't filter on two fields in one query
// (role == "doctor" AND verificationStatus == "Pending" together), so
// this pulls every doctor once via an indexed query on "role", then
// splits into Pending/Verified/Rejected tabs client-side. Fine at
// capstone scale — worth revisiting with a dedicated index node only
// if the doctor list grows into the hundreds.
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
  query,
  orderByChild,
  equalTo,
  onValue,
  update,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { firebaseConfig } from "./firebase-init.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let currentAdminUid = null;
let currentAdminEmail = null;
let allDoctors = []; // raw list, refreshed live from Firebase
let activeTab = "Pending";
let searchTerm = "";
let activeReviewUid = null;

// ── DOM refs ─────────────────────────────────────────────────────────
const accountLabel = document.getElementById("account-label");
const logoutBtn = document.getElementById("logout-btn");
const tabButtons = document.querySelectorAll(".tab");
const searchInput = document.getElementById("search-input");
const cardGrid = document.getElementById("card-grid");
const emptyState = document.getElementById("empty-state");
const loadingRow = document.getElementById("loading-row");

const overlay = document.getElementById("overlay");
const reviewPanel = document.getElementById("review-panel");
const reviewCloseBtn = document.getElementById("review-close");
const reviewNameEl = document.getElementById("review-name");
const claimName = document.getElementById("claim-name");
const claimLicense = document.getElementById("claim-license");
const claimSpecialization = document.getElementById("claim-specialization");
const claimPhone = document.getElementById("claim-phone");
const claimEmail = document.getElementById("claim-email");
const evidenceImg = document.getElementById("evidence-img");
const evidenceBackSection = document.getElementById("evidence-back-section");
const evidenceBackImg = document.getElementById("evidence-back-img");
const decisionHistory = document.getElementById("decision-history");
const rejectReasonField = document.getElementById("reject-reason-field");
const rejectReasonInput = document.getElementById("reject-reason-input");
const btnApprove = document.getElementById("btn-approve");
const btnReject = document.getElementById("btn-reject");
const btnRejectConfirm = document.getElementById("btn-reject-confirm");
const btnCancel = document.getElementById("btn-cancel");

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");

const toast = document.getElementById("toast");

// ── Guard: must be signed in AND an admin ───────────────────────────
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
  accountLabel.textContent = user.email;

  startListening();
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

// ── Live data ────────────────────────────────────────────────────────
function startListening() {
  const doctorsQuery = query(ref(db), orderByChild("role"), equalTo("doctor"));

  onValue(
    doctorsQuery,
    (snapshot) => {
      loadingRow.style.display = "none";
      allDoctors = [];

      snapshot.forEach((child) => {
        const val = child.val() || {};
        allDoctors.push({
          uid: child.key,
          name: val.name || "Unnamed",
          licenseNumber: val.licenseNumber || val.prcNumber || "—",
          specialization: val.specialization || "—",
          phone: val.phone || "—",
          email: val.email || "—",
          prcIdImageUrl: val.prcIdImageUrl || "",
          prcIdBackImageUrl: val.prcIdBackImageUrl || "",
          verificationStatus: val.verificationStatus || "Pending",
          registeredAt: val.registeredAt || 0,
          reviewedBy: val.reviewedBy || "",
          reviewedByEmail: val.reviewedByEmail || "",
          reviewedAt: val.reviewedAt || 0,
          rejectionReason: val.rejectionReason || "",
        });
      });

      render();

      // If the panel is open for a doctor whose data just changed
      // (e.g. edited in another tab), refresh the open panel too.
      if (activeReviewUid) {
        const stillThere = allDoctors.find((d) => d.uid === activeReviewUid);
        if (stillThere) openReviewPanel(stillThere, /* fromRefresh */ true);
      }
    },
    (err) => {
      loadingRow.textContent =
        "Couldn't load doctors — check your connection and Firebase config.";
      console.error(err);
    },
  );
}

// ── Tabs / search ────────────────────────────────────────────────────
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.status;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
});

searchInput.addEventListener("input", () => {
  searchTerm = searchInput.value.trim().toLowerCase();
  render();
});

// ── Render list ──────────────────────────────────────────────────────
function render() {
  const counts = { Pending: 0, Verified: 0, Rejected: 0 };
  allDoctors.forEach((d) => {
    counts[d.verificationStatus] = (counts[d.verificationStatus] || 0) + 1;
  });

  document.getElementById("count-pending").textContent = counts.Pending || 0;
  document.getElementById("count-verified").textContent = counts.Verified || 0;
  document.getElementById("count-rejected").textContent = counts.Rejected || 0;

  let filtered = allDoctors.filter((d) => d.verificationStatus === activeTab);

  if (searchTerm) {
    filtered = filtered.filter(
      (d) =>
        d.name.toLowerCase().includes(searchTerm) ||
        d.licenseNumber.toLowerCase().includes(searchTerm) ||
        d.email.toLowerCase().includes(searchTerm),
    );
  }

  // Oldest pending first — first submitted, first reviewed
  filtered.sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));

  cardGrid.innerHTML = "";

  if (filtered.length === 0) {
    emptyState.style.display = "block";
    updateEmptyState();
    return;
  }
  emptyState.style.display = "none";

  filtered.forEach((d) => cardGrid.appendChild(buildCard(d)));
}

function updateEmptyState() {
  const icon = document.getElementById("empty-icon");
  const title = document.getElementById("empty-title");
  const desc = document.getElementById("empty-desc");

  if (searchTerm) {
    icon.textContent = "🔍";
    title.textContent = "No matches";
    desc.textContent = "No doctors match your search in this tab.";
    return;
  }

  if (activeTab === "Pending") {
    icon.textContent = "✅";
    title.textContent = "Nothing waiting on you";
    desc.textContent = "New doctor registrations will appear here for review.";
  } else if (activeTab === "Verified") {
    icon.textContent = "🩺";
    title.textContent = "No verified doctors yet";
    desc.textContent = "Approved accounts will be listed here.";
  } else {
    icon.textContent = "🗂️";
    title.textContent = "No rejected accounts";
    desc.textContent = "Rejected registrations will be listed here.";
  }
}

function buildCard(d) {
  const card = document.createElement("div");
  card.className = "doctor-card";
  card.addEventListener("click", () => openReviewPanel(d));

  const badgeClass = d.verificationStatus.toLowerCase();
  const dateStr = d.registeredAt
    ? new Date(d.registeredAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Date unknown";

  card.innerHTML = `
    <div class="doctor-card-top">
      <div>
        <div class="doctor-card-name">${escapeHtml(d.name)}</div>
        <div class="doctor-card-spec">${escapeHtml(d.specialization)}</div>
      </div>
      <span class="badge ${badgeClass}">${d.verificationStatus}</span>
    </div>
    <div class="doctor-card-meta">
      <div class="license">PRC ${escapeHtml(d.licenseNumber)}</div>
      <div>${escapeHtml(d.email)}</div>
    </div>
    <div class="doctor-card-date">Submitted ${dateStr}</div>
  `;
  return card;
}

// ── Review panel ─────────────────────────────────────────────────────
function openReviewPanel(d, fromRefresh) {
  activeReviewUid = d.uid;

  reviewNameEl.textContent = d.name;
  claimName.textContent = d.name;
  claimLicense.textContent = d.licenseNumber;
  claimSpecialization.textContent = d.specialization;
  claimPhone.textContent = d.phone;
  claimEmail.textContent = d.email;

  evidenceImg.src = d.prcIdImageUrl || "";
  evidenceImg.alt = `PRC ID (front) submitted by ${d.name}`;

  // Older registrations have no back image, so hide that section
  if (d.prcIdBackImageUrl) {
    evidenceBackImg.src = d.prcIdBackImageUrl;
    evidenceBackImg.alt = `PRC ID (back) submitted by ${d.name}`;
    evidenceBackSection.style.display = "block";
  } else {
    evidenceBackImg.removeAttribute("src");
    evidenceBackSection.style.display = "none";
  }

  // Show prior decision info if this doctor was already reviewed once
  // (e.g. re-reviewing after a rejection + resubmission)
  if (d.reviewedAt) {
    const when = new Date(d.reviewedAt).toLocaleString();
    let text = `Last reviewed by ${d.reviewedByEmail || "an admin"} on ${when} — marked ${d.verificationStatus}.`;
    if (d.rejectionReason) text += ` Reason: "${d.rejectionReason}"`;
    decisionHistory.textContent = text;
    decisionHistory.style.display = "block";
  } else {
    decisionHistory.style.display = "none";
  }

  // Reset the reject-reason field each time the panel opens fresh
  if (!fromRefresh) {
    rejectReasonField.classList.remove("visible");
    rejectReasonInput.value = "";
    btnReject.style.display = "block";
    btnRejectConfirm.style.display = "none";
    btnCancel.style.display = "none";
    btnApprove.style.display = "block";
  }

  // Already-decided doctors (Verified/Rejected tabs) can still be
  // re-decided — useful if an admin made a mistake, or a rejected
  // doctor's info was manually corrected and deserves another look.
  overlay.classList.add("visible");
  reviewPanel.classList.add("visible");
}

function closeReviewPanel() {
  overlay.classList.remove("visible");
  reviewPanel.classList.remove("visible");
  activeReviewUid = null;
}

reviewCloseBtn.addEventListener("click", closeReviewPanel);
overlay.addEventListener("click", closeReviewPanel);

// Zoom the PRC ID image on click
evidenceImg.addEventListener("click", () => {
  if (!evidenceImg.src) return;
  lightboxImg.src = evidenceImg.src;
  lightbox.classList.add("visible");
});
evidenceBackImg.addEventListener("click", () => {
  if (!evidenceBackImg.src) return;
  lightboxImg.src = evidenceBackImg.src;
  lightbox.classList.add("visible");
});
lightbox.addEventListener("click", () => lightbox.classList.remove("visible"));

// ── Approve ──────────────────────────────────────────────────────────
btnApprove.addEventListener("click", async () => {
  if (!activeReviewUid) return;
  await submitDecision("Verified", "");
});

// ── Reject — two-step: reveal reason field, then confirm ────────────
btnReject.addEventListener("click", () => {
  rejectReasonField.classList.add("visible");
  btnReject.style.display = "none";
  btnRejectConfirm.style.display = "block";
  btnCancel.style.display = "block";
  btnApprove.style.display = "none";
  rejectReasonInput.focus();
});

btnCancel.addEventListener("click", () => {
  rejectReasonField.classList.remove("visible");
  btnReject.style.display = "block";
  btnRejectConfirm.style.display = "none";
  btnCancel.style.display = "none";
  btnApprove.style.display = "block";
});

btnRejectConfirm.addEventListener("click", async () => {
  const reason = rejectReasonInput.value.trim();
  if (!reason) {
    showToast("Add a reason so the doctor knows what to fix.", true);
    return;
  }
  await submitDecision("Rejected", reason);
});

async function submitDecision(status, reason) {
  const uid = activeReviewUid;
  btnApprove.disabled = true;
  btnRejectConfirm.disabled = true;

  const payload = {
    verificationStatus: status,
    reviewedBy: currentAdminUid,
    reviewedByEmail: currentAdminEmail,
    reviewedAt: Date.now(),
    // Firebase RTDB removes a key entirely when set to null — clears
    // any previous rejection reason the moment a doctor is approved.
    rejectionReason: status === "Rejected" ? reason : null,
  };

  try {
    await update(ref(db, uid), payload);
    showToast(
      status === "Verified"
        ? "Doctor approved."
        : "Doctor rejected — reason recorded.",
    );
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't save this decision. Check your connection and try again.",
      true,
    );
  } finally {
    btnApprove.disabled = false;
    btnRejectConfirm.disabled = false;
  }
}

// ── Toast ────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, isError) {
  toast.textContent = message;
  toast.classList.toggle("error", !!isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

// ── Utility ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
