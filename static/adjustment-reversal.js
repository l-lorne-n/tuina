const elements = {
  status: document.querySelector("#reversalStatus"),
  rangeSelect: document.querySelector("#rangeSelect"),
  dateLabel: document.querySelector("#dateLabel"),
  dateInput: document.querySelector("#dateInput"),
  patientSelect: document.querySelector("#patientSelect"),
  therapistSelect: document.querySelector("#therapistSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  recordTable: document.querySelector("#recordTable"),
  reasonCard: document.querySelector("#reasonCard"),
  selectedRecordText: document.querySelector("#selectedRecordText"),
  reasonNoteInput: document.querySelector("#reasonNoteInput"),
  confirmReverseButton: document.querySelector("#confirmReverseButton"),
  cancelReverseButton: document.querySelector("#cancelReverseButton"),
};

let patients = [];
let records = [];
let selectedRecord = null;
let autoLoadTimer = 0;
let loadSequence = 0;

init();

async function init() {
  elements.rangeSelect.value = "month";
  updateDateInput(false);
  elements.rangeSelect.addEventListener("change", () => {
    updateDateInput(true);
    scheduleLoad();
  });
  elements.dateInput.addEventListener("input", () => scheduleLoad(350));
  elements.dateInput.addEventListener("change", () => scheduleLoad());
  elements.patientSelect.addEventListener("change", () => scheduleLoad());
  elements.therapistSelect.addEventListener("change", () => scheduleLoad());
  elements.refreshButton.addEventListener("click", loadRecords);
  elements.cancelReverseButton.addEventListener("click", clearSelection);
  elements.confirmReverseButton.addEventListener("click", submitReverse);
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
  setStatus("正在读取流水");
  try {
    const response = await fetch(`/api/session-summary?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (sequence !== loadSequence) return;
    if (!payload.ok) throw new Error(payload.error || "读取流水失败");
    records = (payload.records || []).filter((item) => !item.isCorrection);
    renderRecords();
    setStatus(`共 ${records.length} 条流水`, "success");
  } catch (error) {
    if (sequence !== loadSequence) return;
    setStatus(error.message || String(error), "error");
  }
}

function renderRecords() {
  if (!records.length) {
    elements.recordTable.innerHTML = '<div class="empty-state">当前范围没有流水</div>';
    return;
  }
  elements.recordTable.innerHTML = `
    <div class="ops-row reversal-row header">
      <div>时间</div><div>类型</div><div>患者</div><div>师傅</div><div>次数</div><div>金额</div><div>剩余变化</div><div>备注</div><div>操作</div>
    </div>
    ${records.map(renderRecord).join("")}
  `;
  elements.recordTable.querySelectorAll("[data-reverse-id]").forEach((button) => {
    button.addEventListener("click", () => selectRecord(Number(button.dataset.reverseId || 0)));
  });
}

function renderRecord(item) {
  const rowClass = ["ops-row", "reversal-row", item.isVoided ? "voided" : "", item.isCorrection ? "correction" : ""]
    .filter(Boolean)
    .join(" ");
  const canReverse = item.operation !== "legacy_recharge" && !item.isVoided && !item.isCorrection;
  return `
    <div class="${rowClass}">
      <div class="ops-muted">${escapeHtml(item.occurredAt || "-")}</div>
      <span class="ops-badge ${item.isCorrection ? "correction" : item.operation === "decrease" ? "decrease" : ""}">${recordTypeLabel(
    item
  )}</span>
      <div>${escapeHtml(patientBusinessLabel(item))}</div>
      <div>${escapeHtml(item.operation === "increase" || item.operation === "legacy_recharge" ? "充值不分师傅" : item.therapist || "未记录")}</div>
      <div>${formatSignedSessionEffect(item)} 次</div>
      <div>${item.operation === "increase" || item.operation === "legacy_recharge" ? `${formatAmount(item.amount)} 元` : "-"}</div>
      <div>${empty(item.beforeSessions)} → ${empty(item.afterSessions)}</div>
      <div class="ops-muted">${escapeHtml(recordNote(item))}</div>
      <div>${canReverse ? `<button type="button" data-reverse-id="${item.id}">冲正</button>` : "-"}</div>
    </div>
  `;
}

function selectRecord(id) {
  selectedRecord = records.find((item) => Number(item.id) === id) || null;
  if (!selectedRecord) return;
  elements.reasonCard.hidden = false;
  elements.reasonNoteInput.value = "";
  document.querySelector('input[name="reason"][value="手误"]').checked = true;
  elements.selectedRecordText.textContent = `将冲正：#${selectedRecord.id} ${selectedRecord.patientName} ${recordTypeLabel(
    selectedRecord
  )} ${formatSignedSessionEffect(selectedRecord)} 次`;
  elements.reasonCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function submitReverse() {
  if (!selectedRecord) return;
  const reason = document.querySelector('input[name="reason"]:checked')?.value || "手误";
  const note = elements.reasonNoteInput.value.trim();
  if (reason === "其他" && !note) {
    setStatus("选择其他时请填写说明", "error");
    return;
  }
  const confirmed = window.confirm(`确认冲正流水 #${selectedRecord.id}？原流水会标记为已冲正，对应次数将恢复；原记录不会删除。`);
  if (!confirmed) return;
  elements.confirmReverseButton.disabled = true;
  const requestKey = `tuina:reverse:${selectedRecord.id}`;
  const requestId = persistentRequestId(requestKey);
  try {
    const response = await fetch(`/api/session-adjustments/${selectedRecord.id}/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason,
        note,
        requestId,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "冲正失败");
    sessionStorage.removeItem(requestKey);
    clearSelection();
    await loadRecords();
    setStatus("冲正完成", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.confirmReverseButton.disabled = false;
  }
}

function persistentRequestId(key) {
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(key, value);
  }
  return value;
}

function clearSelection() {
  selectedRecord = null;
  elements.reasonCard.hidden = true;
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

function recordTypeLabel(item) {
  if (item.isBalanceCorrection) return "余额校正";
  if (item.operation === "legacy_recharge") return "原充值";
  if (item.isCorrection) return item.operation === "increase" ? "冲正充值" : "冲正消费";
  return item.operation === "increase" ? "充值" : "消费";
}

function recordNote(item) {
  if (item.isVoided) return `${item.note || "-"}（已冲正，原因：${item.correctionReason || "已冲正"}）`;
  return item.note || "-";
}

function formatSignedSessionEffect(item) {
  const sessions = Number(item.sessions || 0);
  const effect = item.operation === "decrease" ? -sessions : sessions;
  return `${effect > 0 ? "+" : ""}${formatNumber(effect)}`;
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

function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function empty(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
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
