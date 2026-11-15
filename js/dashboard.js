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
const statTotal = document.getElementById("stat-total");
const statActiveDoctors = document.getElementById("stat-active-doctors");
const statConsultations = document.getElementById("stat-consultations");
const statMedSafety = document.getElementById("stat-med-safety");

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

// ── Activity logs ────────────────────────────────────────────────────
let allActivities = [];
let activityFilters = {
  category: "All",
  doctor: "All",
  status: "All",
  dateFrom: "",
  dateTo: "",
  search: "",
};

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
  DOCTOR_LOGIN: "Account",
  DOCTOR_LOGOUT: "Account",
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
  ];
  if (negative.some((k) => s.includes(k))) return "status-negative";
  if (positive.some((k) => s.includes(k))) return "status-positive";
  return "status-neutral";
}

function startActivityListening() {
  onValue(ref(db, "activityLogs"), (snapshot) => {
    allActivities = [];
    snapshot.forEach((child) => {
      const val = child.val() || {};
      allActivities.push({
        id: child.key,
        doctorUid: val.doctorUid || "",
        doctorName: val.doctorName || "Unknown doctor",
        activityType: val.activityType || "",
        category:
          val.category || ACTIVITY_CATEGORY_MAP[val.activityType] || "Other",
        patientUid: val.patientUid || "",
        patientCode: val.patientCode || "",
        description: val.description || humanizeActivityType(val.activityType),
        status: val.status || "",
        timestamp: val.timestamp || 0,
        relatedRecordId: val.relatedRecordId || "",
      });
    });
    renderActivityFilterOptions();
    renderActivityView();
  });
}

function renderActivityFilterOptions() {
  const doctors = Array.from(
    new Set(allActivities.map((a) => a.doctorName)),
  ).sort();
  const statuses = Array.from(
    new Set(allActivities.map((a) => a.status).filter(Boolean)),
  ).sort();

  const keepOrReset = (select, options, current) =>
    options.includes(current) ? current : "All";

  activityFilters.doctor = keepOrReset(
    activityDoctorFilter,
    doctors,
    activityFilters.doctor,
  );
  activityFilters.status = keepOrReset(
    activityStatusFilter,
    statuses,
    activityFilters.status,
  );

  activityDoctorFilter.innerHTML =
    `<option value="All">All doctors</option>` +
    doctors
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

function renderActivityView() {
  let filtered = allActivities.slice();

  if (activityFilters.category !== "All") {
    filtered = filtered.filter((a) => a.category === activityFilters.category);
  }
  if (activityFilters.doctor !== "All") {
    filtered = filtered.filter((a) => a.doctorName === activityFilters.doctor);
  }
  if (activityFilters.status !== "All") {
    filtered = filtered.filter((a) => a.status === activityFilters.status);
  }
  if (activityFilters.dateFrom) {
    const fromMs = new Date(activityFilters.dateFrom + "T00:00:00").getTime();
    filtered = filtered.filter((a) => a.timestamp >= fromMs);
  }
  if (activityFilters.dateTo) {
    const toMs = new Date(activityFilters.dateTo + "T23:59:59").getTime();
    filtered = filtered.filter((a) => a.timestamp <= toMs);
  }
  if (activityFilters.search) {
    const term = activityFilters.search;
    filtered = filtered.filter(
      (a) =>
        a.doctorName.toLowerCase().includes(term) ||
        a.description.toLowerCase().includes(term),
    );
  }

  filtered.sort((a, b) => b.timestamp - a.timestamp);

  // Summary cards always reflect the full dataset, not the filtered view
  statTotal.textContent = allActivities.length;
  statActiveDoctors.textContent = new Set(
    allActivities.map((a) => a.doctorUid),
  ).size;
  statConsultations.textContent = allActivities.filter(
    (a) => a.category === "Consultation",
  ).length;
  statMedSafety.textContent = allActivities.filter(
    (a) => a.category === "Medication Safety Review",
  ).length;

  activityTableBody.innerHTML = "";

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.innerHTML = `
      <div class="empty-state-cell">
        <div class="icon">📋</div>
        <h3>No activity yet</h3>
        <p>Doctor actions will appear here as they happen.</p>
      </div>
    `;
    tr.appendChild(td);
    activityTableBody.appendChild(tr);
    return;
  }

  filtered.forEach((a) => activityTableBody.appendChild(buildActivityRow(a)));
}

function buildActivityRow(a) {
  const tr = document.createElement("tr");
  tr.className = "doctor-row";

  const dateStr = a.timestamp
    ? new Date(a.timestamp).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

  tr.innerHTML = `
    <td>${escapeHtml(a.doctorName)}</td>
    <td>${escapeHtml(a.description)}</td>
    <td>${escapeHtml(a.category)}</td>
    <td>${escapeHtml(a.patientCode || "—")}</td>
    <td class="doctor-row-date">${dateStr}</td>
    <td>${a.status ? `<span class="badge ${getStatusBadgeClass(a.status)}">${escapeHtml(a.status)}</span>` : "—"}</td>
    <td><button type="button" class="btn-logout" style="padding:6px 10px;font-size:12px;">View</button></td>
  `;
  tr.querySelector("button").addEventListener("click", () =>
    openActivityDetail(a),
  );
  return tr;
}

function openActivityDetail(a) {
  activityDetailTitle.textContent = a.description;
  const dateStr = a.timestamp ? new Date(a.timestamp).toLocaleString() : "—";
  activityDetailRows.innerHTML = `
    <div class="claim-row"><div class="k">Doctor</div><div class="v">${escapeHtml(a.doctorName)}</div></div>
    <div class="claim-row"><div class="k">Category</div><div class="v">${escapeHtml(a.category)}</div></div>
    <div class="claim-row"><div class="k">Activity type</div><div class="v mono">${escapeHtml(a.activityType || "—")}</div></div>
    <div class="claim-row"><div class="k">Patient</div><div class="v">${escapeHtml(a.patientCode || "—")}</div></div>
    <div class="claim-row"><div class="k">Date &amp; time</div><div class="v">${escapeHtml(dateStr)}</div></div>
    <div class="claim-row"><div class="k">Status</div><div class="v">${escapeHtml(a.status || "—")}</div></div>
    <div class="claim-row"><div class="k">Related record</div><div class="v mono">${escapeHtml(a.relatedRecordId || "—")}</div></div>
  `;
  overlay.classList.add("visible");
  activityDetailPanel.classList.add("visible");
}

function closeActivityDetail() {
  activityDetailPanel.classList.remove("visible");
}

activityDetailClose.addEventListener("click", closeActivityDetail);

activityCategoryFilter.addEventListener("change", () => {
  activityFilters.category = activityCategoryFilter.value;
  renderActivityView();
});
activityDoctorFilter.addEventListener("change", () => {
  activityFilters.doctor = activityDoctorFilter.value;
  renderActivityView();
});
activityStatusFilter.addEventListener("change", () => {
  activityFilters.status = activityStatusFilter.value;
  renderActivityView();
});
activityDateFrom.addEventListener("change", () => {
  activityFilters.dateFrom = activityDateFrom.value;
  renderActivityView();
});
activityDateTo.addEventListener("change", () => {
  activityFilters.dateTo = activityDateTo.value;
  renderActivityView();
});
activitySearchInput.addEventListener("input", () => {
  activityFilters.search = activitySearchInput.value.trim().toLowerCase();
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
