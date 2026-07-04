const elements = {
  pageSummary: document.querySelector("#pageSummary"),
  fullRecordLink: document.querySelector("#fullRecordLink"),
  directSignLink: document.querySelector("#directSignLink"),
  nameValue: document.querySelector("#nameValue"),
  genderValue: document.querySelector("#genderValue"),
  ageValue: document.querySelector("#ageValue"),
  phoneValue: document.querySelector("#phoneValue"),
  weightValue: document.querySelector("#weightValue"),
  heightValue: document.querySelector("#heightValue"),
  addressValue: document.querySelector("#addressValue"),
  notesValue: document.querySelector("#notesValue"),
  directorySignatureBox: document.querySelector("#directorySignatureBox"),
  caseSignatureBox: document.querySelector("#caseSignatureBox"),
  visitSignatureSelect: document.querySelector("#visitSignatureSelect"),
  visitSignatureBox: document.querySelector("#visitSignatureBox"),
  remainingValue: document.querySelector("#remainingValue"),
  adjustStatus: document.querySelector("#adjustStatus"),
  increaseInput: document.querySelector("#increaseInput"),
  increaseAmountInput: document.querySelector("#increaseAmountInput"),
  decreaseInput: document.querySelector("#decreaseInput"),
  increaseButton: document.querySelector("#increaseButton"),
  decreaseButton: document.querySelector("#decreaseButton"),
  adjustmentList: document.querySelector("#adjustmentList"),
  originalRechargeList: document.querySelector("#originalRechargeList"),
};

let patientId = 0;
let patient = null;
let signature = {};
let visitSignatures = [];
let adjustments = [];
let increaseAmountEdited = false;

const DEFAULT_SESSION_PRICE = 90;

init();

async function init() {
  patientId = Number(new URLSearchParams(window.location.search).get("patientId") || 0);
  if (!patientId) {
    setStatus("缺少 patientId，无法读取患者", "error");
    return;
  }
  bindEvents();
  await loadPage();
}

function bindEvents() {
  elements.visitSignatureSelect.addEventListener("change", renderSelectedVisitSignature);
  elements.increaseInput.addEventListener("input", () => {
    if (!increaseAmountEdited) updateDefaultIncreaseAmount();
  });
  elements.increaseAmountInput.addEventListener("input", () => {
    increaseAmountEdited = true;
  });
  elements.increaseButton.addEventListener("click", () => submitAdjustment("increase"));
  elements.decreaseButton.addEventListener("click", () => submitAdjustment("decrease"));
}

async function loadPage() {
  const response = await fetch(`/api/session-page/${patientId}`, { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) {
    setStatus(payload.error || "读取失败", "error");
    return;
  }
  patient = payload.patient;
  signature = payload.signature || {};
  visitSignatures = normalizeVisitSignatures(payload.visitSignatures || [], signature);
  adjustments = payload.adjustments || [];
  renderPage();
}

function renderPage() {
  elements.pageSummary.textContent = `第 ${patient.order} 位，剩余 ${
    patient.remainingSessions ?? "-"
  } 次`;
  elements.fullRecordLink.href = `/?patientId=${patient.id}`;
  elements.directSignLink.href = `/signature-pad.html?patientId=${patient.id}&kind=visit&returnTo=${encodeURIComponent(
    `/patient-sessions.html?patientId=${patient.id}`
  )}`;

  setText(elements.nameValue, patient.name);
  setText(elements.genderValue, patient.gender);
  setText(elements.ageValue, patient.age);
  setText(elements.phoneValue, patient.phone);
  setText(elements.weightValue, patient.weight);
  setText(elements.heightValue, patient.height);
  setText(elements.addressValue, patient.address);
  setText(elements.notesValue, patient.notes);
  elements.remainingValue.textContent = patient.remainingSessions ?? "-";

  renderSignatureBox(elements.directorySignatureBox, signature.directorySignature, "目录签名");
  renderSignatureBox(elements.caseSignatureBox, signature.caseSignature, "病历签名");
  renderVisitSignatureSelect();
  if (!increaseAmountEdited) updateDefaultIncreaseAmount();
  renderAdjustmentList();
  renderOriginalRecharges();
}

function normalizeVisitSignatures(history, signatureItem) {
  const seen = new Set();
  const items = [];
  for (const item of history) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
  }
  if (signatureItem.visitSignature && !seen.has(signatureItem.visitSignature)) {
    items.push({
      url: signatureItem.visitSignature,
      savedAt: signatureItem.electronicSignatureUpdatedAt || "",
      signerName: "",
      note: "",
    });
  }
  return items;
}

function renderSignatureBox(container, url, label) {
  if (!url) {
    container.innerHTML = '<span class="empty-signature">未绑定</span>';
    return;
  }
  const imageUrl = `${url}?v=${Date.now()}`;
  container.innerHTML = `<a href="${imageUrl}" target="_blank" rel="noreferrer"><img src="${imageUrl}" alt="${escapeHtml(
    patient.name
  )} ${label}" /></a>`;
}

function renderVisitSignatureSelect() {
  elements.visitSignatureSelect.innerHTML = "";
  if (!visitSignatures.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无推拿签字";
    elements.visitSignatureSelect.appendChild(option);
    elements.visitSignatureBox.innerHTML = '<span class="empty-signature">未绑定</span>';
    return;
  }

  visitSignatures.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1} · ${dateLabel(item.savedAt)}`;
    elements.visitSignatureSelect.appendChild(option);
  });
  elements.visitSignatureSelect.value = String(visitSignatures.length - 1);
  renderSelectedVisitSignature();
}

function renderSelectedVisitSignature() {
  const index = Number(elements.visitSignatureSelect.value || 0);
  const item = visitSignatures[index];
  if (!item || !item.url) {
    elements.visitSignatureBox.innerHTML = '<span class="empty-signature">未绑定</span>';
    return;
  }
  const imageUrl = `${item.url}?v=${encodeURIComponent(item.savedAt || Date.now())}`;
  const meta = [dateLabel(item.savedAt), item.note].filter(Boolean).join(" | ");
  elements.visitSignatureBox.innerHTML = `
    <a href="${imageUrl}" target="_blank" rel="noreferrer"><img src="${imageUrl}" alt="${escapeHtml(
    patient.name
  )} 推拿签字" /></a>
    ${meta ? `<div class="adjustment-muted">${escapeHtml(meta)}</div>` : ""}
  `;
}

function renderAdjustmentList() {
  if (!adjustments.length) {
    elements.adjustmentList.innerHTML = '<div class="empty-state">还没有通过本页产生的次数流水</div>';
    return;
  }
  elements.adjustmentList.innerHTML = adjustments.map(renderAdjustment).join("");
}

function renderAdjustment(item) {
  const isIncrease = item.operation === "increase";
  return `
    <div class="adjustment-row">
      <span class="operation-badge ${isIncrease ? "" : "decrease"}">${
    isIncrease ? "充值" : "消费"
  }</span>
      <div class="adjustment-main">${isIncrease ? "+" : "-"}${escapeHtml(item.sessions)} 次</div>
      <div class="adjustment-muted">${
        isIncrease ? `金额 ${escapeHtml(formatAmount(item.amount))}` : "消费扣次"
      }</div>
      <div class="adjustment-muted">剩余 ${empty(item.beforeSessions)} → ${escapeHtml(
    item.afterSessions
  )}</div>
      <div class="adjustment-muted">${escapeHtml(item.note || "-")}</div>
      <div class="adjustment-muted">${escapeHtml(item.occurredAt || "空空")}</div>
    </div>
  `;
}

function renderOriginalRecharges() {
  const recharges = patient.recharges || [];
  if (!recharges.length) {
    elements.originalRechargeList.innerHTML = '<div class="empty-state">没有原录入充值记录</div>';
    return;
  }
  elements.originalRechargeList.innerHTML = recharges
    .map(
      (item, index) => `
        <div class="adjustment-row">
          <span class="operation-badge">充值</span>
          <div class="adjustment-main">${escapeHtml(item.sessions ?? "-")} 次</div>
          <div class="adjustment-muted">金额 ${escapeHtml(item.amount ?? "-")}</div>
          <div class="adjustment-muted">${escapeHtml(item.rawText || "-")}</div>
          <div class="adjustment-muted">${escapeHtml(item.date || "空空")} · ${index + 1}</div>
        </div>
      `
    )
    .join("");
}

async function submitAdjustment(operation) {
  const input = operation === "increase" ? elements.increaseInput : elements.decreaseInput;
  const sessions = Number(input.value || 0);
  if (!Number.isInteger(sessions) || sessions <= 0) {
    setStatus("次数必须是正整数", "error");
    return;
  }

  const label = operation === "increase" ? "充值" : "消费";
  const amount = operation === "increase" ? Number(elements.increaseAmountInput.value || 0) : null;
  if (operation === "increase" && (!Number.isFinite(amount) || amount < 0)) {
    setStatus("充值金额不能小于 0", "error");
    return;
  }
  const amountNote = operation === "increase" ? `，金额 ${formatAmount(amount)} 元` : "";
  const confirmed = window.confirm(
    `确认给 ${patient.name} ${label}${sessions}次${amountNote}吗？\n确认后会真实更新剩余次数、写入次数流水，并跳转到签名页。`
  );
  if (!confirmed) return;

  setButtonsDisabled(true);
  setStatus(`正在记录${label}流水`);
  try {
    const response = await fetch(`/api/session-adjustments/${patient.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation,
        sessions,
        amount,
        note: `${label}${sessions}次${amountNote}`,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "保存失败");

    patient = payload.patient;
    adjustments = payload.adjustments || [];
    elements.remainingValue.textContent = patient.remainingSessions ?? "-";
    renderAdjustmentList();
    setStatus(`已记录${label}${sessions}次，正在跳转到签名`, "success");
    const adjustment = payload.adjustment || {};
    window.setTimeout(() => {
      const returnTo = encodeURIComponent(`/patient-sessions.html?patientId=${patient.id}`);
      const signedAmountNote =
        operation === "increase" ? ` | 金额 ${formatAmount(adjustment.amount)}元` : "";
      const note = encodeURIComponent(
        `${label}${sessions}次${signedAmountNote} | 流水 #${adjustment.id || ""} | ${
          adjustment.occurredAt || ""
        }`
      );
      window.location.href = `/signature-pad.html?patientId=${patient.id}&kind=visit&note=${note}&returnTo=${returnTo}`;
    }, 600);
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  elements.increaseButton.disabled = disabled;
  elements.decreaseButton.disabled = disabled;
}

function updateDefaultIncreaseAmount() {
  const sessions = Number(elements.increaseInput.value || 0);
  elements.increaseAmountInput.value =
    Number.isInteger(sessions) && sessions > 0 ? String(sessions * DEFAULT_SESSION_PRICE) : "";
}

function setStatus(message, tone = "") {
  elements.adjustStatus.textContent = message;
  elements.adjustStatus.classList.toggle("error", tone === "error");
  elements.adjustStatus.classList.toggle("success", tone === "success");
}

function setText(element, value) {
  element.textContent = empty(value);
}

function empty(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function dateLabel(value) {
  return value ? String(value).slice(0, 10) : "空空";
}

function formatAmount(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
