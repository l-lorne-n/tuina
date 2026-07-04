const browserSummary = document.querySelector("#browserSummary");
const signatureBrowserSearch = document.querySelector("#signatureBrowserSearch");
const signatureBrowserFilter = document.querySelector("#signatureBrowserFilter");
const signatureBrowserGrid = document.querySelector("#signatureBrowserGrid");

const pinyinCollator = new Intl.Collator("zh-Hans-CN-u-co-pinyin", {
  sensitivity: "base",
  numeric: true,
});

let patientsById = new Map();
let signatureItems = [];
let signatureManifestVersion = "";

init();

async function init() {
  signatureBrowserSearch.addEventListener("input", render);
  signatureBrowserFilter.addEventListener("change", render);
  await Promise.all([loadPatients(), loadSignatureManifest()]);
  signatureItems.sort((left, right) => {
    const leftName = patientName(left);
    const rightName = patientName(right);
    return pinyinCollator.compare(leftName, rightName) || Number(left.order) - Number(right.order);
  });
  render();
}

async function loadPatients() {
  const response = await fetch("/api/patients", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取患者失败");
  patientsById = new Map((payload.patients || []).map((patient) => [Number(patient.id), patient]));
}

async function loadSignatureManifest() {
  const response = await fetch("/api/signature-manifest", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) return;
  const manifest = payload.manifest || {};
  signatureManifestVersion = encodeURIComponent(manifest.generatedAt || Date.now());
  signatureItems = manifest.items || [];
}

function render() {
  const query = signatureBrowserSearch.value.trim();
  const filter = signatureBrowserFilter.value;
  const visible = signatureItems.filter((item) => {
    const patient = patientsById.get(Number(item.patientId));
    const name = patient ? patient.name : item.name;
    const queryMatch = !query || `${item.order}${name}${item.originalName || ""}`.includes(query);
    const filterMatch =
      filter === "all" ||
      (filter === "with-image" && item.hasDirectorySignature) ||
      (filter === "missing" && !item.hasDirectorySignature);
    return queryMatch && filterMatch;
  });

  browserSummary.textContent = `按拼音顺序显示 ${visible.length} / ${signatureItems.length} 人`;
  signatureBrowserGrid.innerHTML = visible.length
    ? visible.map((item) => renderBrowserCard(item)).join("")
    : '<div class="empty-state">没有匹配的签名</div>';
}

function renderBrowserCard(item) {
  const patient = patientsById.get(Number(item.patientId));
  const name = patient ? patient.name : item.name;
  const remaining = patient && patient.remainingSessions != null ? patient.remainingSessions : "-";
  const imageUrl = item.directorySignature
    ? `${item.directorySignature}?v=${signatureManifestVersion}`
    : "";
  return `
    <a class="browser-card" href="/patient-search.html?patientId=${item.patientId}">
      <div class="browser-card-head">
        <div class="browser-card-title">${escapeHtml(name)}</div>
        <span class="small-badge ${item.status}">${statusLabel(item.status)}</span>
      </div>
      <div class="browser-image">
        ${
          imageUrl
            ? `<img src="${imageUrl}" alt="${escapeHtml(name)} 目录签名" loading="lazy" />`
            : '<span class="signature-slot-empty">缺目录签名图</span>'
        }
      </div>
      <div class="browser-card-foot">
        <span>${String(item.order).padStart(3, "0")}</span>
        <span>剩余 ${escapeHtml(remaining)} 次</span>
      </div>
    </a>
  `;
}

function patientName(item) {
  const patient = patientsById.get(Number(item.patientId));
  return patient ? patient.name : item.name || "";
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
