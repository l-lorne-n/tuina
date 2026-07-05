const elements = {
  summaryStatus: document.querySelector("#summaryStatus"),
  rangeSelect: document.querySelector("#rangeSelect"),
  dateLabel: document.querySelector("#dateLabel"),
  dateInput: document.querySelector("#dateInput"),
  patientSelect: document.querySelector("#patientSelect"),
  therapistSelect: document.querySelector("#therapistSelect"),
  loadSummaryButton: document.querySelector("#loadSummaryButton"),
  rechargeAmountValue: document.querySelector("#rechargeAmountValue"),
  rechargeDetailValue: document.querySelector("#rechargeDetailValue"),
  rechargeSessionsValue: document.querySelector("#rechargeSessionsValue"),
  rechargeCountValue: document.querySelector("#rechargeCountValue"),
  massageSessionsValue: document.querySelector("#massageSessionsValue"),
  massageCountValue: document.querySelector("#massageCountValue"),
  patientCountValue: document.querySelector("#patientCountValue"),
  recordCountValue: document.querySelector("#recordCountValue"),
  therapistStatsTable: document.querySelector("#therapistStatsTable"),
  recordTable: document.querySelector("#recordTable"),
};

let patients = [];
let autoLoadTimer = 0;
let summaryRequestId = 0;

init();

async function init() {
  elements.rangeSelect.addEventListener("change", () => {
    updateDateInputForRange(true);
    scheduleSummaryLoad();
  });
  elements.dateInput.addEventListener("input", () => scheduleSummaryLoad(350));
  elements.dateInput.addEventListener("change", () => scheduleSummaryLoad());
  elements.patientSelect.addEventListener("change", () => scheduleSummaryLoad());
  elements.therapistSelect.addEventListener("change", () => scheduleSummaryLoad());
  elements.loadSummaryButton.addEventListener("click", loadSummary);
  updateDateInputForRange(false);
  await loadPatients();
  await loadSummary();
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
    option.textContent = `${String(patient.order).padStart(3, "0")} · ${patient.name}`;
    elements.patientSelect.appendChild(option);
  }
}

async function loadSummary() {
  window.clearTimeout(autoLoadTimer);
  if (!elements.dateInput.value) return;
  const requestId = ++summaryRequestId;
  const params = new URLSearchParams({
    range: elements.rangeSelect.value,
    date: elements.dateInput.value,
  });
  if (elements.patientSelect.value) params.set("patientId", elements.patientSelect.value);
  if (elements.therapistSelect.value) params.set("therapist", elements.therapistSelect.value);

  setStatus("正在读取流水");
  elements.loadSummaryButton.disabled = true;
  try {
    const response = await fetch(`/api/session-summary?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (requestId !== summaryRequestId) return;
    if (!payload.ok) {
      setStatus(payload.error || "读取失败", "error");
      return;
    }
    renderSummary(payload);
  } catch (error) {
    if (requestId === summaryRequestId) {
      setStatus(error.message || String(error), "error");
    }
  } finally {
    if (requestId === summaryRequestId) {
      elements.loadSummaryButton.disabled = false;
    }
  }
}

function scheduleSummaryLoad(delay = 120) {
  window.clearTimeout(autoLoadTimer);
  autoLoadTimer = window.setTimeout(loadSummary, delay);
}

function renderSummary(payload) {
  const summary = payload.summary || {};
  const filters = payload.filters || {};
  const scopeText = scopeLabel(filters.range, filters.date);

  elements.rechargeAmountValue.textContent = `${formatAmount(summary.rechargeAmount)} 元`;
  elements.rechargeDetailValue.textContent = `${scopeText}，充值不分师傅，流水 ${
    summary.rechargeCount || 0
  } 条`;
  elements.rechargeSessionsValue.textContent = `${formatNumber(summary.rechargeSessions)} 次`;
  elements.rechargeCountValue.textContent = `充值记录 ${summary.rechargeCount || 0} 条`;
  elements.massageSessionsValue.textContent = `${formatNumber(summary.massageSessions)} 次`;
  elements.massageCountValue.textContent = `消费流水 ${summary.massageCount || 0} 条`;
  elements.patientCountValue.textContent = `${summary.patientCount || 0} 人`;
  elements.recordCountValue.textContent = `总流水 ${summary.recordCount || 0} 条`;

  renderTherapistStats(payload.therapistStats || []);
  renderRecords(payload.records || []);
  setStatus(`${scopeText}，共 ${summary.recordCount || 0} 条流水`, "success");
}

function renderTherapistStats(items) {
  if (!items.length) {
    elements.therapistStatsTable.innerHTML = '<div class="empty-state">没有师傅统计</div>';
    return;
  }
  elements.therapistStatsTable.innerHTML = `
    <div class="summary-row therapist-row header">
      <div>师傅</div>
      <div>干活次数</div>
      <div>消费流水</div>
    </div>
    ${items
      .map(
        (item) => `
          <div class="summary-row therapist-row">
            <div class="summary-main">${escapeHtml(item.therapist)}</div>
            <div>${formatNumber(item.workSessions)} 次</div>
            <div>${formatNumber(item.workCount)} 条</div>
          </div>
        `
      )
      .join("")}
  `;
}

function renderRecords(records) {
  if (!records.length) {
    elements.recordTable.innerHTML = '<div class="empty-state">当前筛选范围内没有流水</div>';
    return;
  }
  elements.recordTable.innerHTML = `
    <div class="summary-row record-row header">
      <div>时间</div>
      <div>类型</div>
      <div>患者</div>
      <div>师傅</div>
      <div>次数</div>
      <div>金额</div>
      <div>剩余变化</div>
      <div>签名</div>
      <div>备注</div>
    </div>
    ${records.map(renderRecord).join("")}
  `;
}

function renderRecord(item) {
  const isIncrease = item.operation === "increase";
  const isLegacyRecharge = item.operation === "legacy_recharge";
  const isRecharge = isIncrease || isLegacyRecharge;
  const amountText = isRecharge ? `${formatAmount(item.amount)} 元` : "-";
  const typeLabel = isLegacyRecharge ? "原充值" : isIncrease ? "充值" : "消费";
  const badgeClass = isRecharge ? "" : "decrease";
  const sessionPrefix = isRecharge ? "+" : "-";
  return `
    <div class="summary-row record-row">
      <div class="summary-muted">${escapeHtml(item.occurredAt || "-")}</div>
      <span class="summary-badge ${badgeClass}">${typeLabel}</span>
      <div>${String(item.patientOrder).padStart(3, "0")} · ${escapeHtml(item.patientName)}</div>
      <div>${escapeHtml(isRecharge ? "充值不分师傅" : item.therapist || "未记录")}</div>
      <div>${sessionPrefix}${formatNumber(item.sessions)} 次</div>
      <div>${amountText}</div>
      <div>${empty(item.beforeSessions)} → ${empty(item.afterSessions)}</div>
      <div>${renderSignatureStatus(item)}</div>
      <div class="summary-muted">${escapeHtml(item.note || "-")}</div>
    </div>
  `;
}

function renderSignatureStatus(item) {
  if (item.operation === "legacy_recharge") return '<span class="summary-muted">原记录</span>';
  if (item.signatureStatus === "signed" && item.signatureUrl) {
    return `<span class="summary-signature signed">已签名</span><a class="text-link" href="${escapeHtml(
      item.signatureUrl
    )}" target="_blank" rel="noreferrer">查看</a>`;
  }
  return `<span class="summary-signature pending">待签名</span><a class="text-link" href="${signAdjustmentUrl(
    item
  )}">去签名</a>`;
}

function signAdjustmentUrl(item) {
  const note = encodeURIComponent(
    `流水 #${item.id} | ${item.occurredAt || "-"} | ${
      item.operation === "increase" ? "充值" : "消费"
    }${item.operation === "increase" ? "+" : "-"}${formatNumber(item.sessions)}次`
  );
  const returnTo = encodeURIComponent("/session-summary.html");
  return `/signature-pad.html?patientId=${item.patientId}&kind=flow&adjustmentId=${item.id}&note=${note}&returnTo=${returnTo}`;
}

function updateDateInputForRange(resetValue) {
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

function scopeLabel(range, date) {
  if (range === "month") return `${date} 月`;
  if (range === "year") return `${date} 年`;
  return `${date}`;
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
  elements.summaryStatus.textContent = message;
  elements.summaryStatus.classList.toggle("error", tone === "error");
  elements.summaryStatus.classList.toggle("success", tone === "success");
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
