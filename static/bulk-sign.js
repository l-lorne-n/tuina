const elements = {
  status: document.querySelector("#bulkStatus"),
  rangeSelect: document.querySelector("#rangeSelect"),
  dateLabel: document.querySelector("#dateLabel"),
  dateInput: document.querySelector("#dateInput"),
  patientSelect: document.querySelector("#patientSelect"),
  therapistSelect: document.querySelector("#therapistSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  selectAllCheckbox: document.querySelector("#selectAllCheckbox"),
  selectionSummary: document.querySelector("#selectionSummary"),
  recordTable: document.querySelector("#recordTable"),
  signerNameInput: document.querySelector("#signerNameInput"),
  signatureNoteInput: document.querySelector("#signatureNoteInput"),
  signatureCanvas: document.querySelector("#signatureCanvas"),
  clearButton: document.querySelector("#clearButton"),
  saveButton: document.querySelector("#saveButton"),
};

let patients = [];
let records = [];
let selectedIds = new Set();
let autoLoadTimer = 0;
let loadSequence = 0;
let context = null;
let pixelRatio = 1;
let drawing = false;
let hasDrawing = false;

init();

async function init() {
  context = elements.signatureCanvas.getContext("2d", { alpha: false });
  elements.rangeSelect.value = "month";
  updateDateInput(false);
  bindEvents();
  resizeCanvas();
  await loadPatients();
  await loadTherapists();
  await loadRecords();
}

async function loadTherapists() {
  const response = await fetch("/api/therapists", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取师傅失败");
  elements.therapistSelect.innerHTML = '<option value="">全部师傅</option>';
  for (const name of payload.therapists || []) elements.therapistSelect.add(new Option(name, name));
}

function bindEvents() {
  elements.rangeSelect.addEventListener("change", () => {
    updateDateInput(true);
    scheduleLoad();
  });
  elements.dateInput.addEventListener("input", () => scheduleLoad(350));
  elements.dateInput.addEventListener("change", () => scheduleLoad());
  elements.patientSelect.addEventListener("change", () => scheduleLoad());
  elements.therapistSelect.addEventListener("change", () => scheduleLoad());
  elements.refreshButton.addEventListener("click", loadRecords);
  elements.selectAllCheckbox.addEventListener("change", toggleSelectAll);
  elements.clearButton.addEventListener("click", clearCanvas);
  elements.saveButton.addEventListener("click", saveBulkSignature);
  elements.signatureCanvas.addEventListener("pointerdown", startDraw);
  elements.signatureCanvas.addEventListener("pointermove", moveDraw);
  elements.signatureCanvas.addEventListener("pointerup", endDraw);
  elements.signatureCanvas.addEventListener("pointercancel", endDraw);
  window.addEventListener("resize", resizeCanvas);
}

async function loadPatients() {
  const response = await fetch("/api/patients", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取患者失败");
  patients = payload.patients || [];
  elements.patientSelect.innerHTML = '<option value="">全部患者</option>';
  for (const patient of patients) {
    const option = document.createElement("option");
    option.value = String(patient.id);
    option.textContent = patientBusinessLabel(patient);
    elements.patientSelect.appendChild(option);
  }
}

async function loadRecords() {
  window.clearTimeout(autoLoadTimer);
  const sequence = ++loadSequence;
  const params = new URLSearchParams({
    range: elements.rangeSelect.value,
    date: elements.dateInput.value,
  });
  if (elements.patientSelect.value) params.set("patientId", elements.patientSelect.value);
  if (elements.therapistSelect.value) params.set("therapist", elements.therapistSelect.value);
  setStatus("正在读取待补签流水");
  try {
    const response = await fetch(`/api/pending-signatures?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (sequence !== loadSequence) return;
    if (!payload.ok) throw new Error(payload.error || "读取待补签流水失败");
    records = payload.records || [];
    selectedIds = new Set([...selectedIds].filter((id) => records.some((item) => Number(item.id) === id)));
    renderRecords();
    updateSelectionSummary();
    setStatus(`共 ${records.length} 条待补签流水`, "success");
  } catch (error) {
    if (sequence !== loadSequence) return;
    setStatus(error.message || String(error), "error");
  }
}

function renderRecords() {
  if (!records.length) {
    elements.recordTable.innerHTML = '<div class="empty-state">当前范围没有待补签流水</div>';
    elements.selectAllCheckbox.checked = false;
    return;
  }
  elements.recordTable.innerHTML = `
    <div class="ops-row bulk-row header">
      <div>选择</div><div>时间</div><div>类型</div><div>患者</div><div>师傅</div><div>次数</div><div>金额</div><div>备注</div>
    </div>
    ${records.map(renderRecord).join("")}
  `;
  elements.recordTable.querySelectorAll("[data-select-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const id = Number(checkbox.dataset.selectId || 0);
      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelectionSummary();
    });
  });
  elements.selectAllCheckbox.checked = records.length > 0 && records.every((item) => selectedIds.has(Number(item.id)));
}

function renderRecord(item) {
  const id = Number(item.id);
  return `
    <div class="ops-row bulk-row">
      <label class="bulk-checkbox-label"><input type="checkbox" data-select-id="${id}" ${
    selectedIds.has(id) ? "checked" : ""
  } /></label>
      <div class="ops-muted">${escapeHtml(item.occurredAt || "-")}</div>
      <span class="ops-badge ${item.operation === "decrease" ? "decrease" : ""}">${
    item.operation === "increase" ? "充值" : "消费"
  }</span>
      <div>${escapeHtml(patientBusinessLabel(item))}</div>
      <div>${escapeHtml(item.operation === "increase" ? "充值不分师傅" : item.therapist || "未记录")}</div>
      <div>${formatSignedSessionEffect(item)} 次</div>
      <div>${item.operation === "increase" ? `${formatAmount(item.amount)} 元` : "-"}</div>
      <div class="ops-muted">${escapeHtml(item.note || "-")}</div>
    </div>
  `;
}

function toggleSelectAll() {
  if (elements.selectAllCheckbox.checked) {
    for (const item of records) selectedIds.add(Number(item.id));
  } else {
    selectedIds.clear();
  }
  renderRecords();
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const selected = records.filter((item) => selectedIds.has(Number(item.id)));
  const rechargeAmount = selected
    .filter((item) => item.operation === "increase")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const massageSessions = selected
    .filter((item) => item.operation === "decrease")
    .reduce((sum, item) => sum + Number(item.sessions || 0), 0);
  elements.selectionSummary.textContent = selected.length
    ? `已选择 ${selected.length} 条，涉及 ${new Set(selected.map((item) => item.patientId)).size} 位患者，充值 ${formatAmount(
        rechargeAmount
      )} 元，消费 ${formatAmount(massageSessions)} 次`
    : "未选择流水";
}

async function saveBulkSignature() {
  if (!selectedIds.size) {
    setStatus("请先选择要补签的流水", "error");
    return;
  }
  if (!hasDrawing) {
    setStatus("请先签名", "error");
    return;
  }
  const confirmed = window.confirm(`确认用当前签名批量补签 ${selectedIds.size} 条流水？`);
  if (!confirmed) return;
  elements.saveButton.disabled = true;
  setStatus("正在保存批量补签");
  const selectedKey = [...selectedIds].sort((a, b) => a - b).join(",");
  const requestKey = `tuina:bulk-sign:${selectedKey}`;
  let requestId = sessionStorage.getItem(requestKey);
  if (!requestId) {
    requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(requestKey, requestId);
  }
  try {
    const response = await fetch("/api/bulk-signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adjustmentIds: [...selectedIds],
        signerName: elements.signerNameInput.value.trim(),
        note: elements.signatureNoteInput.value.trim(),
        requestId,
        imageData: elements.signatureCanvas.toDataURL("image/png"),
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "批量补签失败");
    sessionStorage.removeItem(requestKey);
    selectedIds.clear();
    clearCanvas();
    await loadRecords();
    setStatus(`批量补签完成：批次 #${payload.batch?.id || "-"}`, "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.saveButton.disabled = false;
  }
}

function startDraw(event) {
  drawing = true;
  hasDrawing = true;
  elements.signatureCanvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  context.beginPath();
  context.moveTo(point.x, point.y);
}

function moveDraw(event) {
  if (!drawing) return;
  const point = canvasPoint(event);
  context.lineTo(point.x, point.y);
  context.strokeStyle = "#111";
  context.lineWidth = Math.max(2, (event.pressure || 0.5) * 4);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.stroke();
}

function endDraw(event) {
  if (!drawing) return;
  drawing = false;
  try {
    elements.signatureCanvas.releasePointerCapture(event.pointerId);
  } catch (_) {}
}

function canvasPoint(event) {
  const rect = elements.signatureCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * pixelRatio,
    y: (event.clientY - rect.top) * pixelRatio,
  };
}

function resizeCanvas() {
  const rect = elements.signatureCanvas.getBoundingClientRect();
  pixelRatio = window.devicePixelRatio || 1;
  elements.signatureCanvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
  elements.signatureCanvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  clearCanvas();
}

function clearCanvas() {
  context.fillStyle = "#fff";
  context.fillRect(0, 0, elements.signatureCanvas.width, elements.signatureCanvas.height);
  hasDrawing = false;
}

function scheduleLoad(delay = 120) {
  window.clearTimeout(autoLoadTimer);
  autoLoadTimer = window.setTimeout(loadRecords, delay);
}

function updateDateInput(resetValue) {
  const range = elements.rangeSelect.value;
  const now = new Date();
  if (range === "day") {
    elements.dateLabel.textContent = "日期";
    elements.dateInput.type = "date";
    if (resetValue || !elements.dateInput.value) elements.dateInput.value = formatDate(now);
  } else if (range === "month") {
    elements.dateLabel.textContent = "月份";
    elements.dateInput.type = "month";
    if (resetValue || !elements.dateInput.value) elements.dateInput.value = formatMonth(now);
  } else {
    elements.dateLabel.textContent = "年份";
    elements.dateInput.type = "number";
    elements.dateInput.min = "2000";
    elements.dateInput.max = "2100";
    elements.dateInput.step = "1";
    if (resetValue || !elements.dateInput.value) elements.dateInput.value = String(now.getFullYear());
  }
}

function formatSignedSessionEffect(item) {
  const sessions = Number(item.sessions || 0);
  const effect = item.operation === "decrease" ? -sessions : sessions;
  return `${effect > 0 ? "+" : ""}${formatAmount(effect)}`;
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatMonth(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function setStatus(message, tone = "") {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", tone === "error");
  elements.status.classList.toggle("success", tone === "success");
}

function formatAmount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function patientBusinessLabel(item) {
  const name = item.patientName || item.name || "-";
  const address = item.patientAddress || item.address || "";
  const recordNo = item.patientRecordNo ?? item.recordNo ?? "";
  if (address && recordNo !== "") return `${address} ${recordNo}号 · ${name}`;
  if (address) return `${address} · ${name}`;
  if (recordNo !== "") return `无地址 ${recordNo}号 · ${name}`;
  return name;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
