const summaryText = document.querySelector("#summaryText");
const searchInput = document.querySelector("#signatureSearchInput");
const filterSelect = document.querySelector("#filterSelect");
const signatureGrid = document.querySelector("#signatureGrid");

let manifestItems = [];
let manifestVersion = "";

init();

async function init() {
  searchInput.addEventListener("input", render);
  filterSelect.addEventListener("change", render);
  await loadManifest();
}

async function loadManifest() {
  const response = await fetch("/api/signature-manifest", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) {
    summaryText.textContent = payload.error || "签名绑定读取失败";
    return;
  }
  manifestItems = payload.manifest.items || [];
  manifestVersion = encodeURIComponent(payload.manifest.generatedAt || Date.now());
  summaryText.textContent = `共 ${payload.manifest.count} 人，目录签名图 ${payload.manifest.directoryCount} 张，生成时间 ${payload.manifest.generatedAt || "-"}`;
  render();
}

function render() {
  const query = searchInput.value.trim();
  const filter = filterSelect.value;
  const visible = manifestItems.filter((item) => {
    const queryMatch = !query || `${item.order}${item.name}${item.originalName}`.includes(query);
    const filterMatch =
      filter === "all" ||
      (filter === "missing" && !item.hasDirectorySignature) ||
      (filter === "completed" && item.status === "completed") ||
      (filter === "pending" && item.status !== "completed");
    return queryMatch && filterMatch;
  });

  signatureGrid.innerHTML = "";
  if (!visible.length) {
    signatureGrid.innerHTML = '<div class="empty-state">没有匹配的签名卡片</div>';
    return;
  }

  for (const item of visible) {
    const card = document.createElement("article");
    card.className = `signature-card${item.hasDirectorySignature ? "" : " missing"}`;
    card.innerHTML = `
      <div class="signature-meta">
        <span class="signature-order">${String(item.order).padStart(3, "0")}</span>
        <span class="signature-name">${escapeHtml(item.name)}</span>
        <span class="signature-status ${item.status}">${statusLabel(item.status)}</span>
      </div>
      <div class="signature-image-wrap">
        ${
          item.hasDirectorySignature
            ? `<img src="${item.directorySignature}?v=${manifestVersion}" alt="${escapeHtml(item.name)} 目录签名" loading="lazy" />`
            : '<span class="signature-missing-text">缺目录签名图</span>'
        }
      </div>
      <div class="signature-note">${escapeHtml(item.note || "")}</div>
    `;
    signatureGrid.appendChild(card);
  }
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
