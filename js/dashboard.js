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
let activeReviewUid = null;

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
const rejectReasonField = document.getElementById("reject-reason-field");
const rejectReasonInput = document.getElementById("reject-reason-input");
const btnApprove = document.getElementById("btn-approve");
const btnReject = document.getElementById("btn-reject");
const btnRejectConfirm = document.getElementById("btn-reject-confirm");
const btnCancel = document.getElementById("btn-cancel");
const btnMovePending = document.getElementById("btn-move-pending");

const viewActivity = document.getElementById("view-activity");
const activitySearchInput = document.getElementById("activity-search-input");
const activityCategoryFilter = document.getElementById(
  "activity-category-filter",
);
const activityDoctorFilter = document.getElementById("activity-doctor-filter");
const activityStatusFilter = document.getElementById("activity-status-filter");
const activityDateFrom = document.getElementById("activity-date-from");
const activityDateTo = document.getElementById("activity-date-to");
const activityTableBody = document.getElementById("activity-table-body");
const statToday = document.getElementById("stat-today");
const statAttention = document.getElementById("stat-attention");
const statPending = document.getElementById("stat-pending");
const statActiveUsers = document.getElementById("stat-active-users");
const activityRoleFilter = document.getElementById("activity-role-filter");
const activitySeverityFilter = document.getElementById(
  "activity-severity-filter",
);
const activityClearBtn = document.getElementById("activity-clear-btn");
const activityExportBtn = document.getElementById("activity-export-btn");
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
    viewActivity.style.display = view === "activity" ? "block" : "none";
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
          registeredAt: val.registeredAt || 0,
          reviewedBy: val.reviewedBy || "",
          reviewedByEmail: val.reviewedByEmail || "",
          reviewedAt: val.reviewedAt || 0,
          rejectionReason: val.rejectionReason || "",
          lastDecisionStatus: val.lastDecisionStatus || "",
        });
      });

      renderVerificationView();
      renderSpecializationTabs();
      renderDoctorsView();

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
  role: "All",
  doctor: "All",
  severity: "All",
  status: "All",
  dateFrom: "",
  dateTo: "",
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
  ADMIN_MOVED_TO_PENDING: "Admin Action",
  ADMIN_CREATED: "Admin Action",
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
  ADMIN_MOVED_TO_PENDING: "warning",
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
    renderActivityFilterOptions();
    renderActivityView();
  });
}

function renderActivityFilterOptions() {
  const people = Array.from(
    new Set(allActivities.map((a) => a.actorName)),
  ).sort();
  const statuses = Array.from(
    new Set(allActivities.map((a) => a.status).filter(Boolean)),
  ).sort();

  if (!people.includes(activityFilters.doctor)) activityFilters.doctor = "All";
  if (!statuses.includes(activityFilters.status))
    activityFilters.status = "All";

  activityDoctorFilter.innerHTML =
    `<option value="All">All users</option>` +
    people
      .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
      .join("");
  activityDoctorFilter.value = activityFilters.doctor;

  activityStatusFilter.innerHTML =
    `<option value="All">All statuses</option>` +
    statuses
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join("");
  activityStatusFilter.value = activityFilters.status;
}

function getFilteredActivities() {
  const f = activityFilters;
  let list = allActivities.slice();

  if (f.category !== "All")
    list = list.filter((a) => a.category === f.category);
  if (f.role !== "All") list = list.filter((a) => a.actorRole === f.role);
  if (f.doctor !== "All") list = list.filter((a) => a.actorName === f.doctor);
  if (f.severity !== "All")
    list = list.filter((a) => a.severity === f.severity);
  if (f.status !== "All") list = list.filter((a) => a.status === f.status);
  if (f.dateFrom) {
    const fromMs = new Date(f.dateFrom + "T00:00:00").getTime();
    list = list.filter((a) => a.timestamp >= fromMs);
  }
  if (f.dateTo) {
    const toMs = new Date(f.dateTo + "T23:59:59").getTime();
    list = list.filter((a) => a.timestamp <= toMs);
  }
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

function renderActivityStats() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  statToday.textContent = allActivities.filter(
    (a) => a.timestamp >= startOfToday.getTime(),
  ).length;
  statAttention.textContent = allActivities.filter(
    (a) => a.severity !== "info" && a.timestamp >= weekAgo,
  ).length;
  statActiveUsers.textContent = new Set(
    allActivities
      .filter((a) => a.timestamp >= weekAgo && a.actorUid)
      .map((a) => a.actorUid),
  ).size;
}

function renderActivityView() {
  renderActivityStats();

  const filtered = getFilteredActivities();
  activityTableBody.innerHTML = "";

  if (filtered.length === 0) {
    const hasFilters =
      JSON.stringify(activityFilters) !==
      JSON.stringify(DEFAULT_ACTIVITY_FILTERS);
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.innerHTML = `
      <div class="empty-state-cell">
        <div class="icon">${hasFilters ? "🔍" : "📋"}</div>
        <h3>${hasFilters ? "No matching activity" : "No activity yet"}</h3>
        <p>${hasFilters ? "Try clearing some filters." : "Actions by doctors, patients, caregivers and admins will appear here."}</p>
      </div>
    `;
    tr.appendChild(td);
    activityTableBody.appendChild(tr);
    activityLoadMore.style.display = "none";
    return;
  }

  filtered
    .slice(0, activityVisibleLimit)
    .forEach((a) => activityTableBody.appendChild(buildActivityRow(a)));

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

function buildActivityRow(a) {
  const tr = document.createElement("tr");
  tr.className = "doctor-row";

  tr.innerHTML = `
    <td class="actor-cell">
      <div class="actor-name">${escapeHtml(a.actorName)}</div>
      <div class="actor-role">${escapeHtml(a.actorRole || "—")}</div>
    </td>
    <td>${escapeHtml(a.description)}</td>
    <td>${escapeHtml(a.category)}</td>
    <td class="actor-cell">
      <div class="actor-name">${escapeHtml(a.targetName || a.patientCode || "—")}</div>
      ${a.targetName && a.patientCode ? `<div class="actor-role" style="text-transform:none">${escapeHtml(a.patientCode)}</div>` : ""}
    </td>
    <td class="doctor-row-date">${formatActivityDate(a.timestamp)}</td>
    <td>${a.status ? `<span class="badge ${getStatusBadgeClass(a.status)}">${escapeHtml(a.status)}</span>` : "—"}</td>
    <td><span class="badge sev-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span></td>
  `;
  tr.addEventListener("click", () => openActivityDetail(a));
  return tr;
}

function detailRow(label, value, mono) {
  return `<div class="claim-row"><div class="k">${escapeHtml(label)}</div><div class="v${mono ? " mono" : ""}">${escapeHtml(value || "—")}</div></div>`;
}

function openActivityDetail(a) {
  activityDetailTitle.textContent = a.description;
  const when = a.timestamp
    ? `${new Date(a.timestamp).toLocaleString()} (${new Date(a.timestamp).toISOString()})`
    : "—";

  activityDetailRows.innerHTML =
    detailRow("Who", a.actorName) +
    detailRow("Role", a.actorRole) +
    detailRow("Category", a.category) +
    detailRow("Severity", a.severity) +
    detailRow("Activity type", a.activityType, true) +
    detailRow("Status", a.status) +
    detailRow("Patient code", a.patientCode, true) +
    detailRow("Target", a.targetName) +
    detailRow("Related record", a.relatedRecordId, true) +
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
function bindFilter(el, key, event = "change") {
  el.addEventListener(event, () => {
    activityFilters[key] = el.value;
    activityVisibleLimit = ACTIVITY_PAGE_SIZE;
    renderActivityView();
  });
}
bindFilter(activityCategoryFilter, "category");
bindFilter(activityRoleFilter, "role");
bindFilter(activityDoctorFilter, "doctor");
bindFilter(activitySeverityFilter, "severity");
bindFilter(activityStatusFilter, "status");
bindFilter(activityDateFrom, "dateFrom");
bindFilter(activityDateTo, "dateTo");
activitySearchInput.addEventListener("input", () => {
  activityFilters.search = activitySearchInput.value.trim().toLowerCase();
  activityVisibleLimit = ACTIVITY_PAGE_SIZE;
  renderActivityView();
});

activityClearBtn.addEventListener("click", () => {
  activityFilters = { ...DEFAULT_ACTIVITY_FILTERS };
  activityVisibleLimit = ACTIVITY_PAGE_SIZE;
  activitySearchInput.value = "";
  activityCategoryFilter.value = "All";
  activityRoleFilter.value = "All";
  activitySeverityFilter.value = "All";
  activityDateFrom.value = "";
  activityDateTo.value = "";
  renderActivityFilterOptions();
  renderActivityView();
});

activityLoadMoreBtn.addEventListener("click", () => {
  activityVisibleLimit += ACTIVITY_PAGE_SIZE;
  renderActivityView();
});

// ── Export CSV (respects the current filters) ───────────────────────
function csvCell(value) {
  let s = value === undefined || value === null ? "" : String(value);
  // Stop spreadsheet apps from running cells that start like a formula
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

activityExportBtn.addEventListener("click", () => {
  const rows = getFilteredActivities();
  if (rows.length === 0) {
    showToast("Nothing to export with the current filters.", true);
    return;
  }
  const header = [
    "Time (ISO)",
    "Who",
    "Role",
    "Activity type",
    "Description",
    "Category",
    "Severity",
    "Status",
    "Patient code",
    "Target",
    "Reason",
    "Actor ID",
  ];
  const lines = [header.map(csvCell).join(",")];
  rows.forEach((a) =>
    lines.push(
      [
        a.timestamp ? new Date(a.timestamp).toISOString() : "",
        a.actorName,
        a.actorRole,
        a.activityType,
        a.description,
        a.category,
        a.severity,
        a.status,
        a.patientCode,
        a.targetName,
        a.reason,
        a.actorUid,
      ]
        .map(csvCell)
        .join(","),
    ),
  );
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `medcheck-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  writeAuditLog({
    activityType: "ADMIN_EXPORTED_LOGS",
    category: "Data Access",
    description: `Admin exported ${rows.length} activity log entries`,
    status: "Exported",
  });
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
  statPending.textContent = counts.Pending || 0;

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
      title = "No rejected accounts";
      desc = "Rejected registrations will be listed here.";
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
  const badgeClass = d.verificationStatus.toLowerCase();
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
    <td><span class="badge ${badgeClass}">${escapeHtml(d.verificationStatus)}</span></td>
    <td class="doctor-row-date">${dateStr}</td>
  `;
  return tr;
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
  claimLicense.textContent = d.licenseNumber;
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
  // - If the doctor currently has a final decision (Verified/Rejected),
  //   show that decision.
  // - If the doctor was sent back to Pending after a decision, show
  //   what it *was* (via lastDecisionStatus) until the next real
  //   decision overwrites reviewedBy/reviewedAt/rejectionReason.
  if (d.verificationStatus !== "Pending" && d.reviewedAt) {
    const when = new Date(d.reviewedAt).toLocaleString();
    let text = `Last reviewed by ${d.reviewedByEmail || "an admin"} on ${when} — marked ${d.verificationStatus}.`;
    if (d.rejectionReason) text += ` Reason: "${d.rejectionReason}"`;
    decisionHistory.textContent = text;
    decisionHistory.style.display = "block";
  } else if (
    d.verificationStatus === "Pending" &&
    d.lastDecisionStatus &&
    d.reviewedAt
  ) {
    const when = new Date(d.reviewedAt).toLocaleString();
    let text = `Previously reviewed by ${d.reviewedByEmail || "an admin"} on ${when} — was marked ${d.lastDecisionStatus}.`;
    if (d.lastDecisionStatus === "Rejected" && d.rejectionReason) {
      text += ` Reason: "${d.rejectionReason}"`;
    }
    text += ` Moved back to Pending for re-review.`;
    decisionHistory.textContent = text;
    decisionHistory.style.display = "block";
  } else {
    decisionHistory.style.display = "none";
  }

  const isDecided =
    d.verificationStatus === "Verified" || d.verificationStatus === "Rejected";

  if (isDecided) {
    // Locked decision — the only action is sending it back to Pending
    // for a fresh, deliberate re-review. No direct re-approve/re-reject.
    rejectReasonField.classList.remove("visible");
    btnApprove.style.display = "none";
    btnReject.style.display = "none";
    btnRejectConfirm.style.display = "none";
    btnCancel.style.display = "none";
    btnMovePending.style.display = "block";
  } else {
    // Pending — normal approve / reject-with-reason flow.
    btnMovePending.style.display = "none";
    if (!fromRefresh) {
      rejectReasonField.classList.remove("visible");
      rejectReasonInput.value = "";
      btnReject.style.display = "block";
      btnRejectConfirm.style.display = "none";
      btnCancel.style.display = "none";
      btnApprove.style.display = "block";
    }
  }

  overlay.classList.add("visible");
  reviewPanel.classList.add("visible");
}

function closeReviewPanel() {
  overlay.classList.remove("visible");
  reviewPanel.classList.remove("visible");
  activeReviewUid = null;
}

reviewCloseBtn.addEventListener("click", closeReviewPanel);
overlay.addEventListener("click", () => {
  closeReviewPanel();
  closeActivityDetail();
  closeLogoutConfirm();
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
    // A fresh decision retires whatever "was marked X before being
    // sent back to Pending" snapshot existed.
    lastDecisionStatus: null,
  };

  try {
    const before = allDoctors.find((x) => x.uid === uid);
    await update(ref(db, uid), payload);
    await writeAuditLog({
      activityType:
        status === "Verified"
          ? "ADMIN_DOCTOR_APPROVED"
          : "ADMIN_DOCTOR_REJECTED",
      category: "Admin Action",
      description: `${status === "Verified" ? "Approved" : "Rejected"} ${before?.name || "doctor"}`,
      status: status === "Verified" ? "Approved" : "Rejected",
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

// ── Move back to Pending (from an already-decided doctor) ───────────
btnMovePending.addEventListener("click", async () => {
  if (!activeReviewUid) return;
  await submitMoveToPending();
});

async function submitMoveToPending() {
  const uid = activeReviewUid;
  const doctor = allDoctors.find((d) => d.uid === uid);
  if (!doctor) return;

  btnMovePending.disabled = true;

  const payload = {
    verificationStatus: "Pending",
    // Snapshot what it was decided as, so the panel can still show
    // "previously marked Verified/Rejected" until the next real
    // decision overwrites reviewedBy/reviewedAt/rejectionReason.
    lastDecisionStatus: doctor.verificationStatus,
  };

  try {
    await update(ref(db, uid), payload);
    await writeAuditLog({
      activityType: "ADMIN_MOVED_TO_PENDING",
      category: "Admin Action",
      description: `Moved ${doctor.name} back to Pending`,
      status: "Pending",
      severity: "warning",
      targetUid: uid,
      targetName: doctor.name,
      changes: {
        verificationStatus: { from: doctor.verificationStatus, to: "Pending" },
      },
    });
    showToast("Doctor moved back to Pending for re-review.");
    closeReviewPanel();
  } catch (err) {
    console.error(err);
    showToast(
      "Couldn't move this doctor to Pending. Check your connection and try again.",
      true,
    );
  } finally {
    btnMovePending.disabled = false;
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
