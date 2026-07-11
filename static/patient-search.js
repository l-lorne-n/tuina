const searchSummary = document.querySelector("#searchSummary");
const patientSearchInput = document.querySelector("#patientSearchInput");
const patientSortSelect = document.querySelector("#patientSortSelect");
const clearSearchButton = document.querySelector("#clearSearchButton");
const viewButtons = document.querySelectorAll(".view-button");
const patientResultGrid = document.querySelector("#patientResultGrid");

let patients = [];
let signatureItemsByPatientId = new Map();
let signatureManifestVersion = "";
let currentView = "cards";

const pinyinCollator = new Intl.Collator("zh-Hans-CN-u-co-pinyin", {
  sensitivity: "base",
  numeric: true,
});

init();

async function init() {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  if (requestedView === "signatures") currentView = "signatures";

  patientSearchInput.addEventListener("input", render);
  patientSortSelect.addEventListener("change", render);
  viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view || "cards";
      updateViewButtons();
      render();
    });
  });
  updateViewButtons();
  clearSearchButton.addEventListener("click", () => {
    patientSearchInput.value = "";
    render();
    patientSearchInput.focus();
  });
  await Promise.all([loadPatients(), loadSignatureManifest()]);
  const requestedId = Number(params.get("patientId") || 0);
  if (requestedId) {
    const patient = patients.find((item) => item.id === requestedId);
    if (patient) patientSearchInput.value = patient.name;
  }
  render();
}

async function loadPatients() {
  const response = await fetch("/api/patients", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取患者失败");
  patients = payload.patients || [];
}

async function loadSignatureManifest() {
  const response = await fetch("/api/signature-manifest", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) return;
  const manifest = payload.manifest || {};
  signatureManifestVersion = encodeURIComponent(manifest.generatedAt || Date.now());
  signatureItemsByPatientId = new Map(
    (manifest.items || []).map((item) => [Number(item.patientId), item])
  );
}

function render() {
  const query = patientSearchInput.value.trim();
  const visible = patients.filter((patient) => patientMatches(patient, query)).sort(comparePatients);
  const viewLabel = currentView === "signatures" ? "签名视图" : "卡片视图";
  const sortLabels = {
    order: "录入顺序",
    address: "地址编号顺序",
    pinyin: "首字母顺序",
  };
  const sortLabel = sortLabels[patientSortSelect.value] || sortLabels.order;

  searchSummary.textContent = query
    ? `匹配 ${visible.length} / ${patients.length} 人，${viewLabel}，${sortLabel}`
    : `共 ${patients.length} 人，${viewLabel}，${sortLabel}`;

  patientResultGrid.className =
    currentView === "signatures" ? "browser-grid" : "patient-card-grid";
  patientResultGrid.innerHTML = visible.length
    ? visible
        .map((patient) =>
          currentView === "signatures" ? renderSignatureBrowserCard(patient) : renderPatientCard(patient)
        )
        .join("")
    : '<div class="empty-state">没有匹配的患者</div>';
}

function renderPatientCard(patient) {
  const signatureItem = signatureItemsByPatientId.get(Number(patient.id));
  const remaining = patient.remainingSessions ?? "-";
  const address = patient.address || "-";
  const recordNo = patient.recordNo ?? "-";
  return `
    <article class="patient-card">
      <div class="patient-card-head">
        <div class="patient-card-title">${escapeHtml(patient.name)}</div>
        <div class="patient-card-links">
          <a class="patient-card-action" href="/patient-sessions.html?patientId=${patient.id}">增减次数</a>
        </div>
      </div>
      <div class="patient-card-meta">
        ${metaItem("剩余次数", remaining)}
        ${metaItem("地址", address)}
        ${metaItem("编号", recordNo)}
      </div>
      ${renderSignatureSet(patient.name, signatureItem)}
    </article>
  `;
}

function metaItem(label, value) {
  return `
    <div class="meta-item">
      <div class="meta-label">${label}</div>
      <div class="meta-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderSignatureSet(name, item) {
  const slots = [
    ["directorySignature", "目录签名"],
    ["flowSignature", "流水签名"],
    ["visitSignature", "推拿签字"],
  ];
  return `
    <div class="signature-set">
      ${slots.map(([key, label]) => renderSignatureSlot(name, item && item[key], label)).join("")}
    </div>
  `;
}

function renderSignatureSlot(name, url, label) {
  const imageUrl = url ? `${url}?v=${signatureManifestVersion}` : "";
  return `
    <div class="signature-slot">
      <div class="signature-slot-title">${label}</div>
      <div class="signature-slot-image">
        ${
          imageUrl
            ? `<a href="${imageUrl}" target="_blank" rel="noreferrer"><img src="${imageUrl}" alt="${escapeHtml(name)} ${label}" /></a>`
            : '<span class="signature-slot-empty">未绑定</span>'
        }
      </div>
    </div>
  `;
}

function renderSignatureBrowserCard(patient) {
  const item = signatureItemsByPatientId.get(Number(patient.id)) || {};
  const imageUrl = item.directorySignature
    ? `${item.directorySignature}?v=${signatureManifestVersion}`
    : "";
  const remaining = patient.remainingSessions != null ? patient.remainingSessions : "-";
  const status = item.status || patient.status;
  return `
    <a class="browser-card" href="/patient-search.html?patientId=${patient.id}">
      <div class="browser-card-head">
        <div class="browser-card-title">${escapeHtml(patient.name)}</div>
        <span class="small-badge ${escapeHtml(status)}">${statusLabel(status)}</span>
      </div>
      <div class="browser-image">
        ${
          imageUrl
            ? `<img src="${imageUrl}" alt="${escapeHtml(patient.name)} 目录签名" loading="lazy" />`
            : '<span class="signature-slot-empty">缺目录签名图</span>'
        }
      </div>
      <div class="browser-card-foot">
        <span>${String(patient.order).padStart(3, "0")}</span>
        <span>剩余 ${escapeHtml(remaining)} 次</span>
      </div>
    </a>
  `;
}

function patientMatches(patient, query) {
  if (!query) return true;
  const orderText = String(patient.order || "");
  const searchable = [
    orderText,
    orderText.padStart(3, "0"),
    patient.name,
    patient.originalName,
    patient.phone,
    patient.address,
    patient.recordNo,
    `${patient.address || ""}${patient.recordNo ?? ""}`,
  ].join("");
  return searchable.includes(query);
}

function comparePatients(left, right) {
  const orderCompare = Number(left.order) - Number(right.order) || Number(left.id) - Number(right.id);
  if (patientSortSelect.value === "address") {
    const leftAddress = left.address || "";
    const rightAddress = right.address || "";
    if (leftAddress && !rightAddress) return -1;
    if (!leftAddress && rightAddress) return 1;
    const addressCompare = pinyinCollator.compare(leftAddress, rightAddress);
    if (addressCompare) return addressCompare;
    const leftNo = Number.isFinite(Number(left.recordNo)) && left.recordNo !== null ? Number(left.recordNo) : null;
    const rightNo = Number.isFinite(Number(right.recordNo)) && right.recordNo !== null ? Number(right.recordNo) : null;
    if (leftNo !== null && rightNo === null) return -1;
    if (leftNo === null && rightNo !== null) return 1;
    if (leftNo !== null && rightNo !== null && leftNo !== rightNo) return leftNo - rightNo;
    return orderCompare;
  }
  if (patientSortSelect.value !== "pinyin") return orderCompare;
  return pinyinCollator.compare(left.name || "", right.name || "") || orderCompare;
}

function updateViewButtons() {
  viewButtons.forEach((button) => {
    const active = button.dataset.view === currentView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function statusLabel(status) {
  if (status === "completed") return "已录";
  if (status === "review") return "复核";
  return "未录";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
