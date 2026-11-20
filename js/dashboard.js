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
  set,
  push,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { firebaseConfig } from "./firebase-init.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let currentAdminUid = null;
let currentAdminEmail = null;
let allDoctors = []; // raw list, refreshed live from Firebase
let activeStatusTab = "Pending";
let verifySearchTerm = "";
let activeSpecTab = "All";
let doctorsSearchTerm = "";
let activeRenewalTab = "awaiting-upload";
let renewalsSearchTerm = "";
let activeReviewUid = null;
let activeReasonAction = null; // null | "reject" | "suspend" | "move-pending"

let activeDocs = [];
let activeDocIndex = 0;

// ── Avatar styling ───────────────────────────────────────────────────
const AVATAR_PALETTE = [
  { bg: "#dcfce7", fg: "#15803d" }, // green
  { bg: "#dbeafe", fg: "#1d4ed8" }, // blue
  { bg: "#ede9fe", fg: "#6d28d9" }, // purple
  { bg: "#fef3c7", fg: "#b45309" }, // amber
  { bg: "#fce7f3", fg: "#be185d" }, // pink
];

// Display-only relabeling — the stored verificationStatus value stays
// "Rejected" (data-status attributes, CSS classes, and the MAUI app all
// key off that string). Only what a human reads changes.
const STATUS_DISPLAY_LABELS = { Rejected: "Verification Unsuccessful" };
function displayLabel(status) {
  return STATUS_DISPLAY_LABELS[status] || status;
}
// Expiry status for a Verified doctor's PRC license.
// null = no date on file / not applicable (e.g. not yet Verified).
function getLicenseExpiryStatus(d) {
  if (d.verificationStatus !== "Verified" || !d.licenseExpiryDate) return null;
  const daysLeft = Math.ceil((d.licenseExpiryDate - Date.now()) / 86400000);
  const dateStr = new Date(d.licenseExpiryDate).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (daysLeft < 0)
    return {
      label: `License expired ${dateStr}`,
      cls: "expired",
      daysLeft,
      dateStr,
    };
  if (daysLeft <= 30)
    return {
      label: `Expires ${dateStr} (${daysLeft}d)`,
      cls: "expiring-soon",
      daysLeft,
      dateStr,
    };
  return null;
}

function getInitials(name) {
  const cleaned = (name || "").replace(/^dr\.?\s+/i, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function getAvatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

// ── Specialization helpers ───────────────────────────────────────────
function getSpecializationTokens(specializationStr) {
  if (!specializationStr || specializationStr === "—") return [];
  return specializationStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSpecializationList(doctors) {
  const seen = new Map(); // lowercase key -> original casing (first seen)
  doctors.forEach((d) => {
    getSpecializationTokens(d.specialization).forEach((token) => {
      const key = token.toLowerCase();
      if (!seen.has(key)) seen.set(key, token);
    });
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

function doctorMatchesSpec(d, spec) {
  if (spec === "All") return true;
  return getSpecializationTokens(d.specialization).some(
    (t) => t.toLowerCase() === spec.toLowerCase(),
  );
}

// ── DOM refs ─────────────────────────────────────────────────────────
const accountLabel = document.getElementById("account-label");
const logoutBtn = document.getElementById("logout-btn");

const navItems = document.querySelectorAll(".nav-item");
const viewVerification = document.getElementById("view-verification");
const viewDoctors = document.getElementById("view-doctors");
const viewRenewals = document.getElementById("view-renewals");
const renewalStatusTabButtons = document.querySelectorAll(
  "#renewal-status-tabs .tab",
);
const renewalsSearchInput = document.getElementById("renewals-search-input");
const renewalsTableBody = document.getElementById("renewals-table-body");

const statusTabButtons = document.querySelectorAll("#status-tabs .tab");
const verifySearchInput = document.getElementById("verify-search-input");
const verificationTableBody = document.getElementById(
  "verification-table-body",
);
const loadingRow = document.getElementById("loading-row");

const specializationSelect = document.getElementById("specialization-select");
const doctorsSearchInput = document.getElementById("doctors-search-input");
const doctorsTableBody = document.getElementById("doctors-table-body");

const overlay = document.getElementById("overlay");
const reviewPanel = document.getElementById("review-panel");
const reviewCloseBtn = document.getElementById("review-close");
const reviewNameEl = document.getElementById("review-name");
const claimName = document.getElementById("claim-name");
const claimTitle = document.getElementById("claim-title");
const claimLicense = document.getElementById("claim-license");
const claimExperience = document.getElementById("claim-experience");
const claimClinic = document.getElementById("claim-clinic");
const claimSpecialization = document.getElementById("claim-specialization");
const claimPhone = document.getElementById("claim-phone");
const claimEmail = document.getElementById("claim-email");
const docGrid = document.getElementById("doc-grid");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");
const lightboxCaption = document.getElementById("lightbox-caption");
const decisionHistory = document.getElementById("decision-history");

// Shared reason step — reused by Reject / Suspend / Move to Pending so we
// don't triplicate the same textarea + confirm/cancel markup three times.
const actionReasonField = document.getElementById("action-reason-field");
const actionReasonLabel = document.getElementById("action-reason-label");
const actionReasonInput = document.getElementById("action-reason-input");
const btnConfirmAction = document.getElementById("btn-confirm-action");
const btnCancelAction = document.getElementById("btn-cancel-action");

const btnApprove = document.getElementById("btn-approve");
const btnReject = document.getElementById("btn-reject");
const btnRequestRenewal = document.getElementById("btn-request-renewal");
const btnSuspend = document.getElementById("btn-suspend");
const btnReactivate = document.getElementById("btn-reactivate");

const approveConfirmModal = document.getElementById("approve-confirm-modal");
const approveCancelBtn = document.getElementById("approve-cancel-btn");
const approveConfirmBtn = document.getElementById("approve-confirm-btn");
const approveExpiryInput = document.getElementById("approve-expiry-input");

const reactivateConfirmModal = document.getElementById(
  "reactivate-confirm-modal",
);
const reactivateCancelBtn = document.getElementById("reactivate-cancel-btn");
const reactivateConfirmBtn = document.getElementById("reactivate-confirm-btn");

const viewStats = document.getElementById("view-stats");
const viewActivity = document.getElementById("view-activity");
const activitySearchInput = document.getElementById("activity-search-input");
const activityCategoryTabs = document.getElementById("activity-category-tabs");
const activityListEl = document.getElementById("activity-list");

const activityLoadMore = document.getElementById("activity-load-more");

const activityLoadMoreBtn = document.getElementById("activity-load-more-btn");
const activityChangesBlock = document.getElementById("activity-changes-block");
const activityChanges = document.getElementById("activity-changes");
const activityReasonBlock = document.getElementById("activity-reason-block");
const activityReason = document.getElementById("activity-reason");

const activityDetailPanel = document.getElementById("activity-detail-panel");
const activityDetailTitle = document.getElementById("activity-detail-title");
const activityDetailRows = document.getElementById("activity-detail-rows");
const activityDetailClose = document.getElementById("activity-detail-close");

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");

const toast = document.getElementById("toast");

const logoutConfirmModal = document.getElementById("logout-confirm-modal");
const logoutCancelBtn = document.getElementById("logout-cancel-btn");
const logoutConfirmBtn = document.getElementById("logout-confirm-btn");

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
  startActivityListening();
});

function closeAllModals() {
  overlay.classList.remove("visible");
  logoutConfirmModal.classList.remove("visible");
  approveConfirmModal.classList.remove("visible");
  reactivateConfirmModal.classList.remove("visible");
  activityDetailPanel.classList.remove("visible");
  reviewPanel.classList.remove("visible");
}

function openLogoutConfirm() {
  overlay.classList.add("visible");
  logoutConfirmModal.classList.add("visible");
}

function closeLogoutConfirm() {
  overlay.classList.remove("visible");
  logoutConfirmModal.classList.remove("visible");
}

logoutBtn.addEventListener("click", () => {
  openLogoutConfirm();
});

logoutCancelBtn.addEventListener("click", closeLogoutConfirm);

logoutConfirmBtn.addEventListener("click", async () => {
  await writeAuditLog({
    activityType: "ADMIN_LOGOUT",
    category: "Admin Action",
    description: "Admin signed out",
    status: "Signed out",
  });
  await signOut(auth);
  window.location.href = "index.html";
});

// ── Sidebar nav ──────────────────────────────────────────────────────
navItems.forEach((item) => {
  item.addEventListener("click", () => {
    navItems.forEach((i) => i.classList.toggle("active", i === item));
    const view = item.dataset.view;
    viewVerification.style.display = view === "verification" ? "block" : "none";
    viewDoctors.style.display = view === "doctors" ? "block" : "none";
    viewRenewals.style.display = view === "renewals" ? "block" : "none";
    viewStats.style.display = view === "stats" ? "block" : "none";
    viewActivity.style.display = view === "activity" ? "block" : "none";
    if (view === "stats") resizeStatsCharts();
  });
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
          professionalTitle: val.professionalTitle || "",
          yearsOfExperience: val.yearsOfExperience || "",
          clinicAffiliation: val.clinicAffiliation || "",
          phone: val.phone || "—",
          email: val.email || "—",
          prcIdImageUrl: val.prcIdImageUrl || "",
          prcIdBackImageUrl: val.prcIdBackImageUrl || "",
          governmentIdImageUrl: val.governmentIdImageUrl || "",
          supportingDocuments: Array.isArray(val.supportingDocuments)
            ? val.supportingDocuments
            : [],
          verificationStatus: val.verificationStatus || "Pending",
          accountStatus: val.accountStatus || "Active",
          registeredAt: val.registeredAt || 0,
          reviewedBy: val.reviewedBy || "",
          reviewedByEmail: val.reviewedByEmail || "",
          reviewedAt: val.reviewedAt || 0,
          rejectionReason: val.rejectionReason || "",
          lastDecisionStatus: val.lastDecisionStatus || "",
          licenseExpiryDate: val.licenseExpiryDate || 0,
          suspensionCategory: val.suspensionCategory || "",
          renewalSubmittedAt: val.renewalSubmittedAt || 0,
        });
      });

      renderVerificationView();
      renderSpecializationTabs();
      renderDoctorsView();
      renderRenewalsView();
      renderStatsView();

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

// ── Audit log writer (admin actions) ─────────────────────────────────
// Entries are append-only (database rules block edits and deletes) and
// stamped with the SERVER's clock, so they can't be backdated.
function cleanForFirebase(obj) {
  const out = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    out[k] = v;
  });
  return out;
}

async function writeAuditLog(entry) {
  if (!currentAdminUid) return;
  try {
    await push(
      ref(db, "activityLogs"),
      cleanForFirebase({
        actorUid: currentAdminUid,
        actorName: currentAdminEmail || "Admin",
        actorRole: "admin",
        severity: "info",
        ...entry,
        timestamp: serverTimestamp(),
        platform: "web-admin",
      }),
    );
  } catch (err) {
    // A failed log must never block the admin's real action.
    console.error("Couldn't write audit log:", err);
  }
}

// ── Activity logs (audit trail) ──────────────────────────────────────
const ACTIVITY_PAGE_SIZE = 100;
let allActivities = [];
let activityVisibleLimit = ACTIVITY_PAGE_SIZE;
const DEFAULT_ACTIVITY_FILTERS = {
  category: "All",
  search: "",
};
let activityFilters = { ...DEFAULT_ACTIVITY_FILTERS };
const ACTIVITY_CATEGORY_MAP = {
  CONSULTATION_POSTED: "Consultation",
  CONSULTATION_UPDATED: "Consultation",
  CONSULTATION_CANCELLED: "Consultation",
  CONSULTATION_REQUEST_ACCEPTED: "Consultation",
  CONSULTATION_REQUEST_DECLINED: "Consultation",
  CONSULTATION_COMPLETED: "Consultation",
  HIGH_RISK_INTERACTION_REVIEWED: "Medication Safety Review",
  MEDICATION_REQUEST_APPROVED: "Medication Safety Review",
  MEDICATION_REQUEST_REJECTED: "Medication Safety Review",
  MEDICATION_ADDED: "Medication Management",
  MEDICATION_UPDATED: "Medication Management",
  MEDICATION_DISCONTINUED: "Medication Management",
  MEDICATION_LIST_REVIEWED: "Medication Management",
  PATIENT_CONNECTION_ACCEPTED: "Patient Connection",
  PATIENT_CONNECTION_REJECTED: "Patient Connection",
  PATIENT_UNLINKED: "Patient Connection",
  PROFILE_UPDATED: "Account",
  DOCTOR_LOGIN: "Account",
  DOCTOR_LOGOUT: "Account",
  DOCTOR_REGISTERED: "Verification",
  DOCTOR_RESUBMITTED: "Verification",
  CREDENTIAL_UPDATE_REQUESTED: "Verification",
  ADMIN_DOCTOR_APPROVED: "Admin Action",
  ADMIN_DOCTOR_REJECTED: "Admin Action",
  ADMIN_REQUESTED_RENEWAL: "Admin Action",
  ADMIN_DOCTOR_SUSPENDED: "Admin Action",
  ADMIN_DOCTOR_REACTIVATED: "Admin Action",
  ADMIN_CREATED: "Admin Action",
  ADMIN_REVOKED: "Admin Action",
  ADMIN_LOGIN: "Admin Action",
  ADMIN_LOGOUT: "Admin Action",
  ADMIN_VIEWED_DOCUMENTS: "Data Access",
  ADMIN_EXPORTED_LOGS: "Data Access",
  PATIENT_RECORD_VIEWED: "Data Access",
  LOGIN_FAILED: "Security",
};

// Used only when an older log has no stored severity.
const SEVERITY_BY_TYPE = {
  ADMIN_DOCTOR_REJECTED: "warning",
  ADMIN_REQUESTED_RENEWAL: "warning",
  ADMIN_DOCTOR_SUSPENDED: "warning",
  ADMIN_REVOKED: "warning",
  ADMIN_CREATED: "warning",
  CREDENTIAL_UPDATE_REQUESTED: "warning",
  HIGH_RISK_INTERACTION_REVIEWED: "warning",
  LOGIN_FAILED: "warning",
};

function humanizeActivityType(type) {
  if (!type) return "Unknown activity";
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getStatusBadgeClass(status) {
  const s = (status || "").toLowerCase();
  const negative = [
    "cancelled",
    "declined",
    "rejected",
    "failed",
    "discontinued",
    "removed",
    "unlinked",
    "revoked",
    "suspended",
  ];
  const positive = [
    "completed",
    "accepted",
    "approved",
    "success",
    "added",
    "updated",
    "reviewed",
    "posted",
    "verified",
    "created",
    "reactivated",
  ];
  if (negative.some((k) => s.includes(k))) return "status-negative";
  if (positive.some((k) => s.includes(k))) return "status-positive";
  return "status-neutral";
}

function normalizeActivity(id, val) {
  const type = val.activityType || "";
  const actorUid = val.actorUid || val.doctorUid || "";
  return {
    id,
    actorUid,
    actorName: val.actorName || val.doctorName || "Unknown user",
    // Older logs only ever came from doctors
    actorRole: val.actorRole || (val.doctorUid ? "doctor" : ""),
    activityType: type,
    category: val.category || ACTIVITY_CATEGORY_MAP[type] || "Other",
    severity: val.severity || SEVERITY_BY_TYPE[type] || "info",
    patientUid: val.patientUid || "",
    patientCode: val.patientCode || "",
    targetUid: val.targetUid || "",
    targetName: val.targetName || "",
    description: val.description || humanizeActivityType(type),
    status: val.status || "",
    timestamp: Number(val.timestamp) || 0,
    relatedRecordId: val.relatedRecordId || "",
    reason: val.reason || "",
    changes:
      val.changes && typeof val.changes === "object" ? val.changes : null,
    appVersion: val.appVersion || "",
    platform: val.platform || "",
  };
}

function startActivityListening() {
  onValue(ref(db, "activityLogs"), (snapshot) => {
    allActivities = [];
    snapshot.forEach((child) => {
      allActivities.push(normalizeActivity(child.key, child.val() || {}));
    });
    renderActivityCategoryTabs();
    renderActivityView();
  });
}

function renderActivityCategoryTabs() {
  const counts = { All: allActivities.length };
  allActivities.forEach((a) => {
    counts[a.category] = (counts[a.category] || 0) + 1;
  });

  const categories = Object.keys(counts)
    .filter((c) => c !== "All")
    .sort((a, b) => a.localeCompare(b));

  if (
    activityFilters.category !== "All" &&
    !categories.includes(activityFilters.category)
  ) {
    activityFilters.category = "All";
  }

  const tabs = ["All", ...categories];
  activityCategoryTabs.innerHTML = tabs
    .map(
      (cat) => `
        <button class="tab${cat === activityFilters.category ? " active" : ""}" data-category="${escapeHtml(cat)}" type="button">
          ${escapeHtml(cat)} <span class="count">${counts[cat] || 0}</span>
        </button>
      `,
    )
    .join("");

  activityCategoryTabs.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activityFilters.category = btn.dataset.category;
      activityVisibleLimit = ACTIVITY_PAGE_SIZE;
      renderActivityCategoryTabs();
      renderActivityView();
    });
  });

  renewalStatusTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      activeRenewalTab = btn.dataset.renewalStatus;
      renewalStatusTabButtons.forEach((b) =>
        b.classList.toggle("active", b === btn),
      );
      renderRenewalsView();
    });
  });

  renewalsSearchInput.addEventListener("input", () => {
    renewalsSearchTerm = renewalsSearchInput.value.trim().toLowerCase();
    renderRenewalsView();
  });
}
function getFilteredActivities() {
  const f = activityFilters;
  let list = allActivities.slice();

  if (f.category !== "All")
    list = list.filter((a) => a.category === f.category);
  if (f.search) {
    const term = f.search;
    list = list.filter((a) =>
      [a.actorName, a.description, a.patientCode, a.targetName, a.activityType]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }
  return list.sort((a, b) => b.timestamp - a.timestamp);
}

function renderActivityView() {
  const filtered = getFilteredActivities();
  activityListEl.innerHTML = "";

  if (filtered.length === 0) {
    const hasFilters =
      JSON.stringify(activityFilters) !==
      JSON.stringify(DEFAULT_ACTIVITY_FILTERS);
    const empty = document.createElement("div");
    empty.innerHTML = `
      <div class="empty-state-cell">
        <div class="icon">${hasFilters ? "🔍" : "📋"}</div>
        <h3>${hasFilters ? "No matching activity" : "No activity yet"}</h3>
        <p>${hasFilters ? "Try a different search or category." : "Actions by doctors, patients, caregivers and admins will appear here."}</p>
      </div>
    `;
    activityListEl.appendChild(empty);
    activityLoadMore.style.display = "none";
    return;
  }

  filtered
    .slice(0, activityVisibleLimit)
    .forEach((a) => activityListEl.appendChild(buildActivityListItem(a)));

  activityLoadMore.style.display =
    filtered.length > activityVisibleLimit ? "block" : "none";
  activityLoadMoreBtn.textContent = `Show more (${filtered.length - activityVisibleLimit} left)`;
}

function formatActivityDate(ts) {
  return ts
    ? new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
}

function buildActivityListItem(a) {
  const row = document.createElement("div");
  row.className = "activity-row";

  const initials = getInitials(a.actorName);
  const avatarColor = getAvatarColor(a.actorUid || a.actorName);

  const subParts = [a.category];
  if (a.targetName) subParts.push(a.targetName);
  else if (a.patientCode) subParts.push(a.patientCode);
  let sub = subParts.join(" · ");
  if (a.reason) sub += ` — "${a.reason}"`;

  const badge = a.status
    ? `<span class="badge ${getStatusBadgeClass(a.status)}">${escapeHtml(a.status)}</span>`
    : `<span class="badge sev-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span>`;

  row.innerHTML = `
    <div class="activity-row-icon" style="background:${avatarColor.bg}; color:${avatarColor.fg}">${escapeHtml(initials)}</div>
    <div class="activity-row-main">
      <div class="activity-row-title">${escapeHtml(a.actorName)} · ${escapeHtml(a.description)}</div>
      <div class="activity-row-sub">${escapeHtml(sub)}</div>
      <div class="activity-row-time">${formatActivityDate(a.timestamp)}</div>
    </div>
    <div class="activity-row-badge">${badge}</div>
  `;
  row.addEventListener("click", () => openActivityDetail(a));
  return row;
}

function detailRow(label, value, mono) {
  return `<div class="claim-row"><div class="k">${escapeHtml(label)}</div><div class="v${mono ? " mono" : ""}">${escapeHtml(value || "—")}</div></div>`;
}

function openActivityDetail(a) {
  activityDetailTitle.textContent = a.description;
  const when = a.timestamp
    ? `${new Date(a.timestamp).toLocaleString()} (${new Date(a.timestamp).toISOString()})`
    : "—";

  // Always-relevant fields, plus fields that only apply to some activity
  // types (e.g. "Patient code" means nothing for an admin sign-out) —
  // those are only shown when the log entry actually has a value for
  // them, instead of printing a row of "—" every time.
  activityDetailRows.innerHTML =
    detailRow("Who", a.actorName) +
    detailRow("Role", a.actorRole) +
    detailRow("Category", a.category) +
    detailRow("Severity", a.severity) +
    detailRow("Activity type", a.activityType, true) +
    (a.status ? detailRow("Status", a.status) : "") +
    (a.patientCode ? detailRow("Patient code", a.patientCode, true) : "") +
    (a.targetName ? detailRow("Target", a.targetName) : "") +
    (a.relatedRecordId
      ? detailRow("Related record", a.relatedRecordId, true)
      : "") +
    detailRow("Actor ID", a.actorUid, true) +
    detailRow(
      "Source",
      [a.platform, a.appVersion].filter(Boolean).join(" · "),
    ) +
    detailRow("When", when);

  const entries = a.changes ? Object.entries(a.changes) : [];
  activityChangesBlock.style.display = entries.length ? "block" : "none";
  activityChanges.innerHTML = entries
    .map(([field, v]) => {
      const from = v && typeof v === "object" ? v.from : "";
      const to = v && typeof v === "object" ? v.to : v;
      return `<div class="change-row">
        <div class="field">${escapeHtml(field)}</div>
        <div class="from">${escapeHtml(String(from ?? "—"))}</div>
        <div class="to">${escapeHtml(String(to ?? "—"))}</div>
      </div>`;
    })
    .join("");

  activityReasonBlock.style.display = a.reason ? "block" : "none";
  activityReason.textContent = a.reason || "";

  overlay.classList.add("visible");
  activityDetailPanel.classList.add("visible");
}

function closeActivityDetail() {
  activityDetailPanel.classList.remove("visible");
}

activityDetailClose.addEventListener("click", closeActivityDetail);

// ── Activity filters ────────────────────────────────────────────────
activitySearchInput.addEventListener("input", () => {
  activityFilters.search = activitySearchInput.value.trim().toLowerCase();
  activityVisibleLimit = ACTIVITY_PAGE_SIZE;
  renderActivityView();
});

activityLoadMoreBtn.addEventListener("click", () => {
  activityVisibleLimit += ACTIVITY_PAGE_SIZE;
  renderActivityView();
});

// ── Verification view: status tabs / search ─────────────────────────
statusTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    activeStatusTab = btn.dataset.status;
    statusTabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    renderVerificationView();
  });
});

verifySearchInput.addEventListener("input", () => {
  verifySearchTerm = verifySearchInput.value.trim().toLowerCase();
  renderVerificationView();
});

function renderVerificationView() {
  const counts = { Pending: 0, Verified: 0, Rejected: 0 };
  allDoctors.forEach((d) => {
    counts[d.verificationStatus] = (counts[d.verificationStatus] || 0) + 1;
  });

  document.getElementById("count-pending").textContent = counts.Pending || 0;
  document.getElementById("count-verified").textContent = counts.Verified || 0;
  document.getElementById("count-rejected").textContent = counts.Rejected || 0;

  let filtered = allDoctors.filter(
    (d) => d.verificationStatus === activeStatusTab,
  );

  if (verifySearchTerm) {
    filtered = filtered.filter(
      (d) =>
        d.name.toLowerCase().includes(verifySearchTerm) ||
        d.licenseNumber.toLowerCase().includes(verifySearchTerm) ||
        d.email.toLowerCase().includes(verifySearchTerm),
    );
  }

  // Oldest pending first — first submitted, first reviewed
  filtered.sort((a, b) => (a.registeredAt || 0) - (b.registeredAt || 0));

  verificationTableBody.innerHTML = "";

  if (filtered.length === 0) {
    let icon = "✅";
    let title = "Nothing waiting on you";
    let desc = "New doctor registrations will appear here for review.";

    if (verifySearchTerm) {
      icon = "🔍";
      title = "No matches";
      desc = "No doctors match your search in this tab.";
    } else if (activeStatusTab === "Verified") {
      icon = "🩺";
      title = "No verified doctors yet";
      desc = "Approved accounts will be listed here.";
    } else if (activeStatusTab === "Rejected") {
      icon = "🗂️";
      title = "No unsuccessful verifications";
      desc = "Doctors whose verification wasn't approved will be listed here.";
    }

    verificationTableBody.appendChild(buildEmptyRow(icon, title, desc));
    return;
  }

  filtered.forEach((d) => verificationTableBody.appendChild(buildRow(d)));
}

// ── Doctors view: specialization tabs / search ──────────────────────
specializationSelect.addEventListener("change", () => {
  activeSpecTab = specializationSelect.value;
  renderDoctorsView();
});

doctorsSearchInput.addEventListener("input", () => {
  doctorsSearchTerm = doctorsSearchInput.value.trim().toLowerCase();
  renderDoctorsView();
});

function renderSpecializationTabs() {
  const specs = buildSpecializationList(allDoctors);

  // Keep the current selection if it still exists in the data,
  // otherwise fall back to "All".
  if (
    activeSpecTab !== "All" &&
    !specs.some((s) => s.toLowerCase() === activeSpecTab.toLowerCase())
  ) {
    activeSpecTab = "All";
  }

  let html = `<option value="All">All (${allDoctors.length})</option>`;
  specs.forEach((spec) => {
    const count = allDoctors.filter((d) => doctorMatchesSpec(d, spec)).length;
    html += `<option value="${escapeHtml(spec)}">${escapeHtml(spec)} (${count})</option>`;
  });

  specializationSelect.innerHTML = html;
  specializationSelect.value = activeSpecTab;
}
function renderDoctorsView() {
  let filtered = allDoctors.filter((d) => doctorMatchesSpec(d, activeSpecTab));

  if (doctorsSearchTerm) {
    filtered = filtered.filter(
      (d) =>
        d.name.toLowerCase().includes(doctorsSearchTerm) ||
        d.licenseNumber.toLowerCase().includes(doctorsSearchTerm) ||
        d.email.toLowerCase().includes(doctorsSearchTerm),
    );
  }

  filtered.sort((a, b) => a.name.localeCompare(b.name));

  doctorsTableBody.innerHTML = "";

  if (filtered.length === 0) {
    const icon = doctorsSearchTerm ? "🔍" : "🩺";
    const title = doctorsSearchTerm ? "No matches" : "No doctors here yet";
    const desc = doctorsSearchTerm
      ? "No doctors match your search in this specialization."
      : "Doctors with this specialization will appear here.";
    doctorsTableBody.appendChild(buildEmptyRow(icon, title, desc));
    return;
  }

  filtered.forEach((d) => doctorsTableBody.appendChild(buildRow(d)));
}

// ── Statistics charts ────────────────────────────────────────────────
let funnelChart = null;
let growthChart = null;
let specChart = null;

function renderStatsView() {
  if (typeof Chart === "undefined") return; // CDN blocked/offline — skip quietly
  renderFunnelChart();
  renderGrowthChart();
  renderSpecializationChart();
}
function renderRenewalsView() {
  const isRenewalSuspended = (d) =>
    d.verificationStatus === "Verified" &&
    d.accountStatus === "Suspended" &&
    d.suspensionCategory === "license-renewal";

  const awaitingUpload = allDoctors.filter(
    (d) => isRenewalSuspended(d) && !d.renewalSubmittedAt,
  );
  const pendingReview = allDoctors.filter(
    (d) => isRenewalSuspended(d) && d.renewalSubmittedAt,
  );

  document.getElementById("count-awaiting-upload").textContent =
    awaitingUpload.length;
  document.getElementById("count-pending-review").textContent =
    pendingReview.length;

  let filtered =
    activeRenewalTab === "awaiting-upload" ? awaitingUpload : pendingReview;

  if (renewalsSearchTerm) {
    filtered = filtered.filter(
      (d) =>
        d.name.toLowerCase().includes(renewalsSearchTerm) ||
        d.licenseNumber.toLowerCase().includes(renewalsSearchTerm) ||
        d.email.toLowerCase().includes(renewalsSearchTerm),
    );
  }

  filtered.sort((a, b) => a.name.localeCompare(b.name));

  renewalsTableBody.innerHTML = "";

  if (filtered.length === 0) {
    const icon = renewalsSearchTerm ? "🔍" : "✅";
    const title = renewalsSearchTerm
      ? "No matches"
      : activeRenewalTab === "awaiting-upload"
        ? "No one waiting on a renewal"
        : "Nothing submitted yet";
    const desc = renewalsSearchTerm
      ? "No doctors match your search in this tab."
      : activeRenewalTab === "awaiting-upload"
        ? "Doctors you suspend for an expired or expiring license will appear here."
        : "Doctors who've uploaded a renewed license will appear here for review.";
    renewalsTableBody.appendChild(buildEmptyRow(icon, title, desc));
    return;
  }

  filtered.forEach((d) => renewalsTableBody.appendChild(buildRow(d)));
}

// Chart.js can't measure a canvas correctly while its container is
// display:none (which it is until this tab is actually opened), so force
// each chart to re-measure itself right after the tab becomes visible.
function resizeStatsCharts() {
  requestAnimationFrame(() => {
    funnelChart?.resize();
    growthChart?.resize();
    specChart?.resize();
  });
}

function renderFunnelChart() {
  const counts = { Pending: 0, Verified: 0, Rejected: 0 };
  allDoctors.forEach((d) => {
    counts[d.verificationStatus] = (counts[d.verificationStatus] || 0) + 1;
  });

  const canvas = document.getElementById("chart-funnel");
  if (!canvas) return;
  if (funnelChart) funnelChart.destroy();
  funnelChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Pending", "Verified", "Verification Unsuccessful"],
      datasets: [
        {
          data: [counts.Pending, counts.Verified, counts.Rejected],
          backgroundColor: ["#f59e0b", "#16a34a", "#dc2626"],
          borderRadius: 6,
        },
      ],
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function renderGrowthChart() {
  const buckets = {}; // "YYYY-MM-DD" -> count
  allDoctors.forEach((d) => {
    if (!d.registeredAt) return;
    const date = new Date(d.registeredAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    buckets[key] = (buckets[key] || 0) + 1;
  });

  const sortedKeys = Object.keys(buckets).sort();
  const labels = sortedKeys.map((k) => {
    const [y, m, day] = k.split("-");
    return new Date(Number(y), Number(m) - 1, Number(day)).toLocaleString(
      undefined,
      { month: "short", day: "numeric" },
    );
  });
  const data = sortedKeys.map((k) => buckets[k]);

  const canvas = document.getElementById("chart-growth");
  if (!canvas) return;
  if (growthChart) growthChart.destroy();
  growthChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "New doctors",
          data,
          borderColor: "#1d4ed8",
          backgroundColor: "rgba(29,78,216,0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function renderSpecializationChart() {
  const specs = buildSpecializationList(allDoctors);
  const data = specs.map(
    (spec) => allDoctors.filter((d) => doctorMatchesSpec(d, spec)).length,
  );

  const canvas = document.getElementById("chart-specialization");
  if (!canvas) return;
  if (specChart) specChart.destroy();
  specChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: specs,
      datasets: [
        {
          data,
          backgroundColor: [
            "#1d4ed8",
            "#16a34a",
            "#f59e0b",
            "#dc2626",
            "#6d28d9",
            "#be185d",
            "#0891b2",
            "#65a30d",
          ],
        },
      ],
    },
    options: {
      plugins: { legend: { position: "right" } },
    },
  });
}

// ── Shared row / empty-state builders ───────────────────────────────
function buildEmptyRow(icon, title, desc) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 5;
  td.innerHTML = `
    <div class="empty-state-cell">
      <div class="icon">${icon}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(desc)}</p>
    </div>
  `;
  tr.appendChild(td);
  return tr;
}

function buildRow(d) {
  const tr = document.createElement("tr");
  tr.className = "doctor-row";
  tr.addEventListener("click", () => openReviewPanel(d));

  const initials = getInitials(d.name);
  const avatarColor = getAvatarColor(d.uid);
  const isSuspended =
    d.verificationStatus === "Verified" && d.accountStatus === "Suspended";
  const isRenewal = isSuspended && d.suspensionCategory === "license-renewal";
  const displayStatus = isRenewal
    ? d.renewalSubmittedAt
      ? "Renewal Submitted"
      : "Renewal Pending"
    : isSuspended
      ? "Suspended"
      : displayLabel(d.verificationStatus);
  const badgeClass = isSuspended
    ? "suspended"
    : d.verificationStatus.toLowerCase();
  const dateStr = d.registeredAt
    ? new Date(d.registeredAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Date unknown";

  tr.innerHTML = `
    <td>
      <div class="doctor-row-user">
        <div class="avatar" style="background:${avatarColor.bg}; color:${avatarColor.fg}">${escapeHtml(initials)}</div>
        <div>
          <div class="doctor-row-name">${escapeHtml(d.name)}</div>
          <div class="doctor-row-sub">PRC ${escapeHtml(d.licenseNumber)}</div>
        </div>
      </div>
    </td>
    <td>
      <div class="doctor-row-contact">
        <div>${escapeHtml(d.email)}</div>
        <div class="doctor-row-sub">${escapeHtml(d.phone)}</div>
      </div>
    </td>
    <td>${escapeHtml(d.specialization)}</td>
      <td>
      <span class="badge ${badgeClass}">${escapeHtml(displayStatus)}</span>
      ${expiryBadgeHtml(d)}
    </td>
    <td class="doctor-row-date">${dateStr}</td>
  `;
  return tr;
}

function expiryBadgeHtml(d) {
  const exp = getLicenseExpiryStatus(d);
  if (!exp) return "";
  return `<span class="badge ${exp.cls}" style="margin-left:4px;">${escapeHtml(exp.label)}</span>`;
}

// ── Review panel: which action buttons show for the doctor's state ──
function applyReviewButtonsForState(d) {
  actionReasonField.classList.remove("visible");
  btnConfirmAction.style.display = "none";
  btnCancelAction.style.display = "none";

  const isPending = d.verificationStatus === "Pending";
  const isVerified = d.verificationStatus === "Verified";
  const isSuspended = isVerified && d.accountStatus === "Suspended";

  btnApprove.style.display = isPending ? "block" : "none";
  btnReject.style.display = isPending ? "block" : "none";
  btnSuspend.style.display = isVerified && !isSuspended ? "block" : "none";
  btnRequestRenewal.style.display =
    isVerified && !isSuspended ? "block" : "none";
  btnReactivate.style.display = isSuspended ? "block" : "none";
}

// ── Review panel ─────────────────────────────────────────────────────
function openReviewPanel(d, fromRefresh) {
  activeReviewUid = d.uid;

  // Viewing a doctor's ID documents is sensitive data access — record it
  // once per opening (not on live refreshes of an already-open panel).
  if (!fromRefresh) {
    writeAuditLog({
      activityType: "ADMIN_VIEWED_DOCUMENTS",
      category: "Data Access",
      description: `Opened verification documents of ${d.name}`,
      status: "Viewed",
      targetUid: d.uid,
      targetName: d.name,
    });
  }

  reviewNameEl.textContent = d.name;
  claimName.textContent = d.name;
  claimTitle.textContent = d.professionalTitle || "—";
  claimLicense.textContent = d.licenseExpiryDate
    ? `${d.licenseNumber} · expires ${new Date(d.licenseExpiryDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : d.licenseNumber;
  claimSpecialization.textContent = d.specialization;
  claimExperience.textContent = d.yearsOfExperience
    ? `${d.yearsOfExperience} ${d.yearsOfExperience === "1" ? "year" : "years"}`
    : "—";
  claimClinic.textContent = d.clinicAffiliation || "—";
  claimPhone.textContent = d.phone;
  claimEmail.textContent = d.email;

  activeDocs = buildDocumentList(d);
  renderDocGrid(activeDocs);

  // Decision history line.
  if (d.verificationStatus !== "Pending" && d.reviewedAt) {
    const when = new Date(d.reviewedAt).toLocaleString();
    let text = `Last reviewed by ${d.reviewedByEmail || "an admin"} on ${when} — marked ${displayLabel(d.verificationStatus)}.`;
    if (d.rejectionReason) text += ` Reason: "${d.rejectionReason}"`;
    decisionHistory.textContent = text;
    decisionHistory.style.display = "block";
  } else if (
    d.verificationStatus === "Pending" &&
    d.lastDecisionStatus &&
    d.reviewedAt
  ) {
    const when = new Date(d.reviewedAt).toLocaleString();
    let text = `Previously reviewed by ${d.reviewedByEmail || "an admin"} on ${when} — was marked ${displayLabel(d.lastDecisionStatus)}.`;
    if (d.lastDecisionStatus === "Rejected" && d.rejectionReason) {
      text += ` Reason: "${d.rejectionReason}"`;
    }
    text += ` Moved back to Pending for re-review.`;
    decisionHistory.textContent = text;
    decisionHistory.style.display = "block";
  } else {
    decisionHistory.style.display = "none";
  }

  if (!fromRefresh) {
    activeReasonAction = null;
    applyReviewButtonsForState(d);
  } else if (!activeReasonAction) {
    applyReviewButtonsForState(d);
  }

  overlay.classList.add("visible");
  reviewPanel.classList.add("visible");
}

function closeReviewPanel() {
  overlay.classList.remove("visible");
  reviewPanel.classList.remove("visible");
  activeReviewUid = null;
  activeReasonAction = null;
}

reviewCloseBtn.addEventListener("click", closeReviewPanel);
overlay.addEventListener("click", () => {
  closeReviewPanel();
  closeActivityDetail();
  closeLogoutConfirm();
  approveConfirmModal.classList.remove("visible");
  reactivateConfirmModal.classList.remove("visible");
});

// ── Document gallery + lightbox ─────────────────────────────────────
function buildDocumentList(d) {
  const docs = [];
  if (d.prcIdImageUrl) {
    docs.push({ label: "PRC ID — Front", url: d.prcIdImageUrl });
  }
  if (d.prcIdBackImageUrl) {
    docs.push({ label: "PRC ID — Back", url: d.prcIdBackImageUrl });
  }
  if (d.governmentIdImageUrl) {
    docs.push({ label: "Government ID", url: d.governmentIdImageUrl });
  }
  (d.supportingDocuments || []).forEach((doc, i) => {
    if (doc && doc.downloadUrl) {
      docs.push({
        label: doc.documentType || `Supporting document ${i + 1}`,
        url: doc.downloadUrl,
      });
    }
  });
  return docs;
}

function renderDocGrid(docs) {
  docGrid.innerHTML = "";

  if (docs.length === 0) {
    docGrid.innerHTML = `<div class="doc-empty">No documents submitted.</div>`;
    return;
  }

  docs.forEach((doc, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "doc-tile";
    tile.innerHTML = `
      <img src="${doc.url}" alt="${escapeHtml(doc.label)}" loading="lazy" />
      <span class="doc-tile-label">${escapeHtml(doc.label)}</span>
    `;
    tile.addEventListener("click", () => openLightbox(index));
    docGrid.appendChild(tile);
  });
}

function openLightbox(index) {
  if (!activeDocs.length) return;
  activeDocIndex = index;
  updateLightbox();
  lightbox.classList.add("visible");
}

function updateLightbox() {
  const doc = activeDocs[activeDocIndex];
  if (!doc) return;
  lightboxImg.src = doc.url;
  lightboxImg.alt = doc.label;
  lightboxCaption.textContent = `${doc.label} (${activeDocIndex + 1} of ${activeDocs.length})`;
  const hasMultiple = activeDocs.length > 1;
  lightboxPrev.style.display = hasMultiple ? "flex" : "none";
  lightboxNext.style.display = hasMultiple ? "flex" : "none";
}

function closeLightbox() {
  lightbox.classList.remove("visible");
}

function showPrevDoc() {
  if (!activeDocs.length) return;
  activeDocIndex = (activeDocIndex - 1 + activeDocs.length) % activeDocs.length;
  updateLightbox();
}

function showNextDoc() {
  if (!activeDocs.length) return;
  activeDocIndex = (activeDocIndex + 1) % activeDocs.length;
  updateLightbox();
}

lightboxClose.addEventListener("click", closeLightbox);
lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  showPrevDoc();
});
lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  showNextDoc();
});
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (!lightbox.classList.contains("visible")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") showPrevDoc();
  else if (e.key === "ArrowRight") showNextDoc();
});

// ── Approve — confirm step (parity with sign-out / suspend) ─────────
btnApprove.addEventListener("click", () => {
  if (!activeReviewUid) return;
  approveExpiryInput.value = "";
  overlay.classList.add("visible");
  approveConfirmModal.classList.add("visible");
});

approveCancelBtn.addEventListener("click", () => {
  overlay.classList.remove("visible");
  approveConfirmModal.classList.remove("visible");
});

approveConfirmBtn.addEventListener("click", async () => {
  const expiryStr = approveExpiryInput.value;
  if (!expiryStr) {
    showToast("Enter the PRC license expiry date to continue.", true);
    return;
  }
  const licenseExpiryDate = new Date(expiryStr + "T00:00:00").getTime();
  overlay.classList.remove("visible");
  approveConfirmModal.classList.remove("visible");
  await submitDecision("Verified", "", licenseExpiryDate);
});

// ── Shared reason step: Reject / Suspend / Move to Pending ──────────
const REASON_STEP_CONFIG = {
  reject: {
    label: "Reason (shown to the doctor)",
    placeholder:
      "e.g. Photo is blurry, license number doesn't match the name on record…",
    confirmText: "Confirm",
  },
  suspend: {
    label: "Reason for suspension (kept in the audit log, shown to the doctor)",
    placeholder: "e.g. Multiple patient complaints, license flagged by PRC…",
    confirmText: "Confirm suspension",
  },
  "request-renewal": {
    label: "Renewal note (kept in the audit log, shown to the doctor)",
    placeholder:
      "e.g. PRC license expired on [date] — please upload your renewed license.",
    confirmText: "Request renewal",
  },
};

function openReasonStep(action) {
  activeReasonAction = action;
  const config = REASON_STEP_CONFIG[action];

  actionReasonLabel.textContent = config.label;
  actionReasonInput.placeholder = config.placeholder;
  actionReasonInput.value = "";
  btnConfirmAction.textContent = config.confirmText;

  actionReasonField.classList.add("visible");
  btnConfirmAction.style.display = "block";
  btnCancelAction.style.display = "block";
  btnApprove.style.display = "none";
  btnReject.style.display = "none";
  btnSuspend.style.display = "none";
  btnReactivate.style.display = "none";
  btnRequestRenewal.style.display = "none";
  actionReasonInput.focus();
}

function closeReasonStep() {
  activeReasonAction = null;
  const d = allDoctors.find((x) => x.uid === activeReviewUid);
  if (d) applyReviewButtonsForState(d);
}

btnReject.addEventListener("click", () => openReasonStep("reject"));
btnSuspend.addEventListener("click", () => openReasonStep("suspend"));
btnRequestRenewal.addEventListener("click", () =>
  openReasonStep("request-renewal"),
);
btnCancelAction.addEventListener("click", closeReasonStep);

btnConfirmAction.addEventListener("click", async () => {
  const reason = actionReasonInput.value.trim();
  if (!reason) {
    showToast("Add a reason to continue.", true);
    return;
  }
  if (activeReasonAction === "reject") {
    await submitDecision("Rejected", reason);
  } else if (activeReasonAction === "suspend") {
    await submitSuspend(reason);
  } else if (activeReasonAction === "request-renewal") {
    await submitRequestRenewal(reason);
  }
});

async function submitDecision(status, reason, licenseExpiryDate) {
  const uid = activeReviewUid;
  approveConfirmBtn.disabled = true;
  btnConfirmAction.disabled = true;

  const payload = {
    verificationStatus: status,
    reviewedBy: currentAdminUid,
    reviewedByEmail: currentAdminEmail,
    reviewedAt: Date.now(),
    rejectionReason: status === "Rejected" ? reason : null,
    lastDecisionStatus: null,
    moveToPendingReason: null,
  };
  if (status === "Verified" && licenseExpiryDate) {
    payload.licenseExpiryDate = licenseExpiryDate;
  }

  try {
    const before = allDoctors.find((x) => x.uid === uid);
    await update(ref(db, uid), payload);
    await writeAuditLog({
      activityType:
        status === "Verified"
          ? "ADMIN_DOCTOR_APPROVED"
          : "ADMIN_DOCTOR_REJECTED",
      category: "Admin Action",
      description: `${status === "Verified" ? "Approved" : "Marked verification unsuccessful for"} ${before?.name || "doctor"}`,
      status: status === "Verified" ? "Approved" : displayLabel(status),
      severity: status === "Verified" ? "info" : "warning",
      targetUid: uid,
      targetName: before?.name || "",
      reason,
      changes: {
        verificationStatus: {
          from: before?.verificationStatus || "—",
          to: status,
        },
      },
    });
    showToast(
      status === "Verified"
        ? "Doctor approved."
        : "Marked as needing further verification — reason recorded.",
    );
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't save this decision. Check your connection and try again.",
      true,
    );
  } finally {
    approveConfirmBtn.disabled = false;
    btnConfirmAction.disabled = false;
  }
}

async function submitRequestRenewal(reason) {
  const uid = activeReviewUid;
  const doctor = allDoctors.find((d) => d.uid === uid);
  if (!doctor) return;

  btnConfirmAction.disabled = true;

  try {
    await update(ref(db, uid), {
      accountStatus: "Suspended",
      suspensionReason: reason,
      suspensionCategory: "license-renewal",
    });
    await writeAuditLog({
      activityType: "ADMIN_REQUESTED_RENEWAL",
      category: "Admin Action",
      description: `Requested license renewal from ${doctor.name}`,
      status: "Renewal requested",
      severity: "warning",
      targetUid: uid,
      targetName: doctor.name,
      reason,
      changes: {
        accountStatus: {
          from: doctor.accountStatus || "Active",
          to: "Suspended",
        },
      },
    });
    showToast(
      "Renewal requested — account suspended until the doctor uploads an updated license.",
    );
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't request renewal. Check your connection and try again.",
      true,
    );
  } finally {
    btnConfirmAction.disabled = false;
  }
}
// ── Suspend / Reactivate — a lever independent of verification ──────
async function submitSuspend(reason) {
  const uid = activeReviewUid;
  const doctor = allDoctors.find((d) => d.uid === uid);
  if (!doctor) return;

  btnConfirmAction.disabled = true;

  try {
    await update(ref(db, uid), {
      accountStatus: "Suspended",
      suspensionReason: reason,
    });
    await writeAuditLog({
      activityType: "ADMIN_DOCTOR_SUSPENDED",
      category: "Admin Action",
      description: `Suspended ${doctor.name}`,
      status: "Suspended",
      severity: "warning",
      targetUid: uid,
      targetName: doctor.name,
      reason,
      changes: {
        accountStatus: {
          from: doctor.accountStatus || "Active",
          to: "Suspended",
        },
      },
    });
    showToast("Doctor account suspended.");
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't suspend this account. Check your connection and try again.",
      true,
    );
  } finally {
    btnConfirmAction.disabled = false;
  }
}

btnReactivate.addEventListener("click", () => {
  if (!activeReviewUid) return;
  overlay.classList.add("visible");
  reactivateConfirmModal.classList.add("visible");
});

reactivateCancelBtn.addEventListener("click", () => {
  overlay.classList.remove("visible");
  reactivateConfirmModal.classList.remove("visible");
});

reactivateConfirmBtn.addEventListener("click", async () => {
  overlay.classList.remove("visible");
  reactivateConfirmModal.classList.remove("visible");
  await submitReactivate();
});

async function submitReactivate() {
  const uid = activeReviewUid;
  const doctor = allDoctors.find((d) => d.uid === uid);
  if (!doctor) return;

  reactivateConfirmBtn.disabled = true;

  try {
    await update(ref(db, uid), {
      accountStatus: "Active",
      suspensionReason: null,
      suspensionCategory: null,
      renewalSubmittedAt: null,
    });
    await writeAuditLog({
      activityType: "ADMIN_DOCTOR_REACTIVATED",
      category: "Admin Action",
      description: `Reactivated ${doctor.name}`,
      status: "Reactivated",
      targetUid: uid,
      targetName: doctor.name,
      changes: { accountStatus: { from: "Suspended", to: "Active" } },
    });
    showToast("Doctor account reactivated.");
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't reactivate this account. Check your connection and try again.",
      true,
    );
  } finally {
    reactivateConfirmBtn.disabled = false;
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
