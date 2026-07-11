const elements = {
  pageSummary: document.querySelector("#pageSummary"),
  nameValue: document.querySelector("#nameValue"),
  genderValue: document.querySelector("#genderValue"),
  ageValue: document.querySelector("#ageValue"),
  phoneValue: document.querySelector("#phoneValue"),
  weightValue: document.querySelector("#weightValue"),
  heightValue: document.querySelector("#heightValue"),
  addressValue: document.querySelector("#addressValue"),
  recordNoValue: document.querySelector("#recordNoValue"),
  notesValue: document.querySelector("#notesValue"),
  directorySignatureBox: document.querySelector("#directorySignatureBox"),
  flowSignatureSelect: document.querySelector("#flowSignatureSelect"),
  flowSignatureBox: document.querySelector("#flowSignatureBox"),
  visitSignatureSelect: document.querySelector("#visitSignatureSelect"),
  visitSignatureBox: document.querySelector("#visitSignatureBox"),
  remainingValue: document.querySelector("#remainingValue"),
  adjustStatus: document.querySelector("#adjustStatus"),
  increaseInput: document.querySelector("#increaseInput"),
  increaseAmountInput: document.querySelector("#increaseAmountInput"),
  decreaseInput: document.querySelector("#decreaseInput"),
  decreaseTherapistInputs: Array.from(document.querySelectorAll('input[name="decreaseTherapist"]')),
  increaseButton: document.querySelector("#increaseButton"),
  increasePendingButton: document.querySelector("#increasePendingButton"),
  decreaseButton: document.querySelector("#decreaseButton"),
  decreasePendingButton: document.querySelector("#decreasePendingButton"),
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
  elements.flowSignatureSelect.addEventListener("change", renderSelectedFlowSignature);
  elements.visitSignatureSelect.addEventListener("change", renderSelectedVisitSignature);
  elements.increaseInput.addEventListener("input", () => {
    if (!increaseAmountEdited) updateDefaultIncreaseAmount();
  });
  elements.increaseAmountInput.addEventListener("input", () => {
    increaseAmountEdited = true;
  });
  elements.increaseButton.addEventListener("click", () => submitAdjustment("increase", true));
  elements.increasePendingButton.addEventListener("click", () => submitAdjustment("increase", false));
  elements.decreaseButton.addEventListener("click", () => submitAdjustment("decrease", true));
  elements.decreasePendingButton.addEventListener("click", () => submitAdjustment("decrease", false));
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
  elements.pageSummary.textContent = `${patientLocationLabel(patient)}，剩余 ${patient.remainingSessions ?? "-"} 次`;

  setText(elements.nameValue, patient.name);
  setText(elements.genderValue, patient.gender);
  setText(elements.ageValue, patient.age);
  setText(elements.phoneValue, patient.phone);
  setText(elements.weightValue, patient.weight);
  setText(elements.heightValue, patient.height);
  setText(elements.addressValue, patient.address);
  setText(elements.recordNoValue, patient.recordNo);
  setText(elements.notesValue, patient.notes);
  elements.remainingValue.textContent = patient.remainingSessions ?? "-";

  renderSignatureBox(elements.directorySignatureBox, signature.directorySignature, "目录签名");
  renderFlowSignatureSelect();
  renderVisitSignatureSelect();
  if (!increaseAmountEdited) updateDefaultIncreaseAmount();
  renderAdjustmentList();
  renderOriginalRecharges();
}

function patientLocationLabel(item) {
  const address = item.address || "";
  const recordNo = item.recordNo ?? "";
  if (address && recordNo !== "") return `${address} ${recordNo}号`;
  if (address) return address;
  if (recordNo !== "") return `无地址 ${recordNo}号`;
  return "未填写地址和编号";
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

function renderFlowSignatureSelect() {
  elements.flowSignatureSelect.innerHTML = "";
  const flowAdjustments = adjustments
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.operation === "increase" && !item.isCorrection);
  if (!flowAdjustments.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无充值流水";
    elements.flowSignatureSelect.appendChild(option);
    elements.flowSignatureBox.innerHTML = '<span class="empty-signature">暂无充值签名</span>';
    return;
  }

  flowAdjustments.forEach(({ item, index }) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${adjustmentLabel(item)} · ${dateLabel(item.occurredAt)} · ${flowSignatureStateLabel(item)}`;
    elements.flowSignatureSelect.appendChild(option);
  });
  elements.flowSignatureSelect.value = "0";
  renderSelectedFlowSignature();
}

function renderSelectedFlowSignature() {
  const index = Number(elements.flowSignatureSelect.value || 0);
  const item = adjustments[index];
  if (!item) {
    elements.flowSignatureBox.innerHTML = '<span class="empty-signature">暂无流水签名</span>';
    return;
  }
  if (item.isCorrection || item.isVoided || item.signatureStatus === "not_required") {
    elements.flowSignatureBox.innerHTML = `
      <div class="flow-signature-empty">
        <strong>${escapeHtml(flowSignatureStateLabel(item))}</strong>
        <span>${escapeHtml(formatAdjustmentMeta(item))}</span>
      </div>
    `;
    return;
  }
  if (item.signatureUrl) {
    const imageUrl = `${item.signatureUrl}?v=${encodeURIComponent(item.signatureSavedAt || Date.now())}`;
    elements.flowSignatureBox.innerHTML = `
      <a href="${imageUrl}" target="_blank" rel="noreferrer"><img src="${imageUrl}" alt="${escapeHtml(
      patient.name
    )} ${adjustmentLabel(item)} 流水签名" /></a>
      <div class="signature-panel-meta">${escapeHtml(formatAdjustmentMeta(item))}</div>
    `;
    return;
  }

  elements.flowSignatureBox.innerHTML = `
    <div class="flow-signature-empty">
      <strong>待签名</strong>
      <span>${escapeHtml(formatAdjustmentMeta(item))}</span>
      <a class="button-link compact" href="${signAdjustmentUrl(item)}">去签名</a>
    </div>
  `;
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
    ${meta ? `<div class="signature-panel-meta">${escapeHtml(meta)}</div>` : ""}
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
  const rowClass = ["adjustment-row", item.isVoided ? "voided" : "", item.isCorrection ? "correction" : ""]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="${rowClass}">
      <span class="operation-badge ${item.isCorrection ? "correction" : isIncrease ? "" : "decrease"}">${adjustmentTypeLabel(
    item
  )}</span>
      <div class="adjustment-main">${formatSignedSessionEffect(item)} 次</div>
      <div class="adjustment-muted">${
        isIncrease ? `金额 ${escapeHtml(formatAmount(item.amount))}` : item.isCorrection ? "冲正消费" : "消费扣次"
      }</div>
      <div class="adjustment-muted">${escapeHtml(
        isIncrease ? "充值不分师傅" : item.therapist || "未记录师傅"
      )}</div>
      <div class="adjustment-muted">
        ${renderAdjustmentSignatureStatus(item)}
        ${
          !item.isVoided && !item.isCorrection && item.signatureUrl
            ? `<a class="text-link" href="${escapeHtml(item.signatureUrl)}" target="_blank" rel="noreferrer">查看</a>`
            : !item.isVoided && !item.isCorrection
            ? `<a class="text-link" href="${signAdjustmentUrl(item)}">去签名</a>`
            : ""
        }
      </div>
      <div class="adjustment-muted">剩余 ${empty(item.beforeSessions)} → ${escapeHtml(
    item.afterSessions
  )}</div>
      <div class="adjustment-muted">${escapeHtml(adjustmentNote(item))}</div>
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

async function submitAdjustment(operation, shouldSign) {
  const input = operation === "increase" ? elements.increaseInput : elements.decreaseInput;
  const sessions = Number(input.value || 0);
  if (!Number.isInteger(sessions) || sessions <= 0) {
    setStatus("次数必须是正整数", "error");
    return;
  }

  const label = operation === "increase" ? "充值" : "消费";
  const therapist = operation === "decrease" ? getSelectedDecreaseTherapist() : "";
  if (operation === "decrease" && !therapist) {
    setStatus("请选择师傅", "error");
    return;
  }
  const amount = operation === "increase" ? Number(elements.increaseAmountInput.value || 0) : null;
  if (operation === "increase" && (!Number.isFinite(amount) || amount < 0)) {
    setStatus("充值金额不能小于 0", "error");
    return;
  }
  const amountNote = operation === "increase" ? `，金额 ${formatAmount(amount)} 元` : "";
  const therapistNote = operation === "decrease" ? `，师傅 ${therapist}` : "";
  const signNote = shouldSign ? "随后会跳转到签名页。" : "本次流水会标记为待签名。";
  const confirmed = window.confirm(
    `确认给 ${patient.name} ${label}${sessions}次${amountNote}${therapistNote} 吗？\n确认后会真实更新剩余次数、写入次数流水。${signNote}`
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
        therapist,
        note: `${label}${sessions}次${amountNote}${therapistNote}`,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "保存失败");

    patient = payload.patient;
    adjustments = payload.adjustments || [];
    elements.remainingValue.textContent = patient.remainingSessions ?? "-";
    renderFlowSignatureSelect();
    renderAdjustmentList();
    if (operation === "decrease") clearDecreaseTherapist();
    const adjustment = payload.adjustment || {};
    if (!shouldSign) {
      setStatus(`已记录${label}${sessions}次，当前为待签名`, "success");
      setButtonsDisabled(false);
      return;
    }
    setStatus(`已记录${label}${sessions}次，正在跳转到签名`, "success");
    window.setTimeout(() => {
      window.location.href = signAdjustmentUrl(adjustment);
    }, 600);
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  elements.increaseButton.disabled = disabled;
  elements.increasePendingButton.disabled = disabled;
  elements.decreaseButton.disabled = disabled;
  elements.decreasePendingButton.disabled = disabled;
  for (const input of elements.decreaseTherapistInputs) input.disabled = disabled;
}

function getSelectedDecreaseTherapist() {
  const selected = elements.decreaseTherapistInputs.find((input) => input.checked);
  return selected ? selected.value : "";
}

function clearDecreaseTherapist() {
  for (const input of elements.decreaseTherapistInputs) input.checked = false;
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

function adjustmentLabel(item) {
  const label = item.operation === "increase" ? "充值" : "消费";
  const sign = item.operation === "increase" ? "+" : "-";
  return `${label}${sign}${item.sessions}次`;
}

function formatAdjustmentMeta(item) {
  const amountText =
    item.operation === "increase" && item.amount !== null && item.amount !== undefined
      ? `，金额 ${formatAmount(item.amount)} 元`
      : "";
  const therapistText = item.operation === "decrease" && item.therapist ? `，师傅 ${item.therapist}` : "";
  const signedText = item.signatureSavedAt ? `，签于 ${item.signatureSavedAt}` : "";
  return `流水 #${item.id} | ${item.occurredAt || "-"} | ${adjustmentLabel(
    item
  )}${amountText}${therapistText}${signedText}`;
}

function signAdjustmentUrl(item) {
  const returnTo = encodeURIComponent(`/patient-sessions.html?patientId=${patient.id}`);
  const note = encodeURIComponent(formatAdjustmentMeta(item));
  const kind = item.operation === "decrease" ? "visit" : "flow";
  return `/signature-pad.html?patientId=${patient.id}&kind=${kind}&adjustmentId=${item.id}&note=${note}&returnTo=${returnTo}`;
}

function signatureStatusLabel(status) {
  return status === "signed" ? "已签名" : "待签名";
}

function signatureStatusClass(status) {
  return status === "signed" ? "signed" : "pending";
}

function flowSignatureStateLabel(item) {
  if (item.isCorrection) return "冲正记录";
  if (item.isVoided) return "已冲正";
  if (item.signatureStatus === "not_required") return "无需签名";
  return signatureStatusLabel(item.signatureStatus);
}

function renderAdjustmentSignatureStatus(item) {
  if (item.isCorrection) return '<span class="signature-status correction">冲正记录</span>';
  if (item.isVoided) return '<span class="signature-status voided">已冲正</span>';
  if (item.signatureStatus === "not_required") return '<span class="signature-status voided">无需签名</span>';
  return `<span class="signature-status ${signatureStatusClass(item.signatureStatus)}">${signatureStatusLabel(
    item.signatureStatus
  )}</span>`;
}

function adjustmentTypeLabel(item) {
  if (item.isCorrection) return item.operation === "increase" ? "冲正充值" : "冲正消费";
  return item.operation === "increase" ? "充值" : "消费";
}

function adjustmentNote(item) {
  if (item.isVoided) {
    const note = item.correctionNote ? `：${item.correctionNote}` : "";
    return `${item.note || "-"}（已冲正，原因：${item.correctionReason || "已冲正"}${note}）`;
  }
  return item.note || "-";
}

function formatSignedSessionEffect(item) {
  const sessions = Number(item.sessions || 0);
  const effect = item.operation === "decrease" ? -sessions : sessions;
  return `${effect > 0 ? "+" : ""}${formatAmount(effect)}`;
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
