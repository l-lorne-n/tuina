const elements = {
  title: document.querySelector("#settlementTitle"),
  status: document.querySelector("#settlementStatus"),
  revokedBanner: document.querySelector("#revokedBanner"),
  rechargeAmountValue: document.querySelector("#rechargeAmountValue"),
  rechargeDetailValue: document.querySelector("#rechargeDetailValue"),
  rechargeSessionsValue: document.querySelector("#rechargeSessionsValue"),
  rechargeCountValue: document.querySelector("#rechargeCountValue"),
  massageSessionsValue: document.querySelector("#massageSessionsValue"),
  massageCountValue: document.querySelector("#massageCountValue"),
  patientCountValue: document.querySelector("#patientCountValue"),
  recordCountValue: document.querySelector("#recordCountValue"),
  therapistStatsTable: document.querySelector("#therapistStatsTable"),
  debtTitle: document.querySelector("#debtTitle"),
  debtTable: document.querySelector("#debtTable"),
  recordTable: document.querySelector("#recordTable"),
  revokeCard: document.querySelector("#revokeCard"),
  revokeReasonSelect: document.querySelector("#revokeReasonSelect"),
  revokeReasonNote: document.querySelector("#revokeReasonNote"),
  revokeButton: document.querySelector("#revokeButton"),
};

let settlement = null;

init();

async function init() {
  elements.revokeButton.addEventListener("click", revokeSettlement);
  const id = Number(new URLSearchParams(window.location.search).get("id") || 0);
  if (!id) {
    setStatus("月结单编号无效", "error");
    return;
  }
  await loadSettlement(id);
}

async function loadSettlement(id) {
  setStatus("正在读取月结快照");
  try {
    const response = await fetch(`/api/settlements/${id}`, { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "读取月结单失败");
    settlement = payload.settlement;
    renderSettlement();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function renderSettlement() {
  const snapshot = settlement.snapshot || {};
  const summary = snapshot.summary || {};
  const range = `${settlement.startDate} 至 ${settlement.endDate}`;
  elements.title.textContent = `${range} 月结单`;
  document.title = `${range} 月结单`;
  elements.debtTitle.textContent = `截至 ${settlement.endDate} 的赊账患者`;
  elements.rechargeAmountValue.textContent = `${formatAmount(summary.rechargeAmount)} 元`;
  elements.rechargeDetailValue.textContent = `有效充值流水 ${summary.rechargeCount || 0} 条`;
  elements.rechargeSessionsValue.textContent = `${formatNumber(summary.rechargeSessions)} 次`;
  elements.rechargeCountValue.textContent = `充值记录 ${summary.rechargeCount || 0} 条`;
  elements.massageSessionsValue.textContent = `${formatNumber(summary.massageSessions)} 次`;
  elements.massageCountValue.textContent = `有效消费流水 ${summary.massageCount || 0} 条`;
  elements.patientCountValue.textContent = `${summary.patientCount || 0} 人`;
  elements.recordCountValue.textContent = `快照流水 ${summary.recordCount || 0} 条`;
  renderTherapistStats(snapshot.therapistStats || []);
  renderDebts(snapshot.debts || []);
  renderRecords(snapshot.records || []);

  if (settlement.status === "revoked") {
    elements.revokedBanner.hidden = false;
    elements.revokedBanner.textContent = `这份月结单已于 ${settlement.revokedAt || "-"} 撤销。原因：${
      settlement.revokedReason || "-"
    }`;
  }
  elements.revokeCard.hidden = !settlement.canRevoke;
  setStatus(
    `${settlement.status === "revoked" ? "已撤销" : "有效"}，生成于 ${settlement.createdAt || snapshot.generatedAt || "-"}`,
    settlement.status === "revoked" ? "" : "success"
  );
}

function renderTherapistStats(items) {
  elements.therapistStatsTable.innerHTML = `
    <div class="summary-row therapist-row header"><div>师傅</div><div>有效推拿次数</div><div>有效消费流水</div></div>
    ${items
      .map(
        (item) => `
          <div class="summary-row therapist-row">
            <div class="summary-main">${escapeHtml(item.therapist)}</div>
            <div>${formatNumber(item.workSessions)} 次</div>
            <div>${formatNumber(item.workCount)} 条</div>
          </div>`
      )
      .join("")}
  `;
}

function renderDebts(items) {
  if (!items.length) {
    elements.debtTable.innerHTML = '<div class="empty-state">结算截止日没有赊账患者</div>';
    return;
  }
  elements.debtTable.innerHTML = `
    <div class="summary-row settlement-debt-row header">
      <div>患者</div><div>电话</div><div>赊账时间</div><div>截止日剩余</div><div>赊账次数</div>
    </div>
    ${items
      .map(
        (item) => `
          <div class="summary-row settlement-debt-row debt">
            <div>${escapeHtml(patientBusinessLabel(item))}</div>
            <div class="summary-muted">${escapeHtml(item.phone || "-")}</div>
            <div class="summary-muted">${escapeHtml(item.debtSince || "-")}</div>
            <div>${escapeHtml(item.remainingSessions)} 次</div>
            <div class="debt-value">${escapeHtml(item.owedSessions)} 次</div>
          </div>`
      )
      .join("")}
  `;
}

function renderRecords(records) {
  if (!records.length) {
    elements.recordTable.innerHTML = '<div class="empty-state">这段时间没有流水</div>';
    return;
  }
  elements.recordTable.innerHTML = `
    <div class="summary-row record-row header">
      <div>时间</div><div>类型</div><div>患者</div><div>师傅</div><div>次数</div><div>金额</div><div>剩余变化</div><div>签名</div><div>备注</div>
    </div>
    ${records.map(renderRecord).join("")}
  `;
}

function renderRecord(item) {
  const isRecharge = item.operation === "increase" || item.operation === "legacy_recharge";
  const rowClass = ["summary-row", "record-row", item.isVoided ? "voided" : ""].filter(Boolean).join(" ");
  return `
    <div class="${rowClass}">
      <div class="summary-muted">${escapeHtml(item.occurredAt || "-")}</div>
      <span class="summary-badge ${isRecharge ? "" : "decrease"}">${recordTypeLabel(item)}</span>
      <div>${escapeHtml(patientBusinessLabel(item))}</div>
      <div>${escapeHtml(isRecharge ? "充值不分师傅" : item.therapist || "未记录")}</div>
      <div>${formatSignedSessionEffect(item)} 次</div>
      <div>${isRecharge ? `${formatAmount(item.amount)} 元` : "-"}</div>
      <div>${empty(item.beforeSessions)} → ${empty(item.afterSessions)}</div>
      <div>${renderSignatureStatus(item)}</div>
      <div class="summary-muted">${escapeHtml(recordNote(item))}</div>
    </div>`;
}

function renderSignatureStatus(item) {
  if (item.operation === "legacy_recharge") return '<span class="summary-muted">原记录</span>';
  if (item.isVoided) return '<span class="summary-signature voided">已冲正</span>';
  if (item.signatureStatus === "signed" && item.signatureUrl) {
    return `<span class="summary-signature signed">已签名</span><a class="text-link" href="${escapeHtml(
      item.signatureUrl
    )}" target="_blank" rel="noreferrer">查看</a>`;
  }
  if (item.signatureStatus === "not_required") return '<span class="summary-muted">无需签名</span>';
  return '<span class="summary-signature pending">生成时待签名</span>';
}

async function revokeSettlement() {
  if (!settlement?.canRevoke) return;
  const selected = elements.revokeReasonSelect.value;
  const note = elements.revokeReasonNote.value.trim();
  if (selected === "其他" && !note) {
    setStatus("选择其他时请填写补充说明", "error");
    return;
  }
  const reason = note ? `${selected}：${note}` : selected;
  const confirmed = window.confirm(
    `确认撤销 ${settlement.startDate} 至 ${settlement.endDate} 的月结单？\n撤销后它会从有效月结列表中移除。`
  );
  if (!confirmed) return;
  elements.revokeButton.disabled = true;
  try {
    const response = await fetch(`/api/settlements/${settlement.id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "撤销月结失败");
    window.location.href = "/settlements.html";
  } catch (error) {
    setStatus(error.message || String(error), "error");
    elements.revokeButton.disabled = false;
  }
}

function recordTypeLabel(item) {
  if (item.isBalanceCorrection) return "余额校正";
  if (item.operation === "legacy_recharge") return "原充值";
  return item.operation === "increase" ? "充值" : "消费";
}

function recordNote(item) {
  if (!item.isVoided) return item.note || "-";
  const reason = item.correctionReason || "已冲正";
  const note = item.correctionNote ? `：${item.correctionNote}` : "";
  return `${item.note || "-"}（已冲正，原因：${reason}${note}）`;
}

function formatSignedSessionEffect(item) {
  const sessions = Number(item.sessions || 0);
  const effect = item.operation === "decrease" ? -sessions : sessions;
  return `${effect > 0 ? "+" : ""}${formatNumber(effect)}`;
}

function formatAmount(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function formatNumber(value) {
  const number = Number(value || 0);
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

function setStatus(message, tone = "") {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", tone === "error");
  elements.status.classList.toggle("success", tone === "success");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
