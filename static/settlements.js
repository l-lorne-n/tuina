const elements = {
  status: document.querySelector("#settlementStatus"),
  startDateInput: document.querySelector("#startDateInput"),
  endDateInput: document.querySelector("#endDateInput"),
  createButton: document.querySelector("#createSettlementButton"),
  dateRuleText: document.querySelector("#dateRuleText"),
  settlementCount: document.querySelector("#settlementCount"),
  settlementList: document.querySelector("#settlementList"),
};

let defaults = {};

init();

async function init() {
  elements.createButton.addEventListener("click", createSettlement);
  elements.startDateInput.addEventListener("change", validateDates);
  elements.endDateInput.addEventListener("change", validateDates);
  await loadSettlements();
}

async function loadSettlements() {
  setStatus("正在读取月结记录");
  try {
    const response = await fetch("/api/settlements", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "读取月结记录失败");
    defaults = payload.defaults || {};
    elements.startDateInput.value = defaults.startDate || "";
    elements.endDateInput.value = defaults.endDate || "";
    elements.startDateInput.readOnly = Boolean(defaults.startLocked);
    elements.startDateInput.classList.toggle("locked", Boolean(defaults.startLocked));
    elements.dateRuleText.textContent = defaults.startLocked
      ? `起始日期由上一份有效月结自动衔接，固定为 ${defaults.startDate}。`
      : "这是第一份月结，可以自行选择起始日期。";
    renderSettlements(payload.settlements || []);
    validateDates();
    setStatus(`共 ${payload.settlements?.length || 0} 份有效月结单`, "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function renderSettlements(items) {
  elements.settlementCount.textContent = `${items.length} 份`;
  if (!items.length) {
    elements.settlementList.innerHTML = '<div class="empty-state">还没有生成月结单</div>';
    return;
  }
  elements.settlementList.innerHTML = items
    .map((item) => {
      const summary = item.summary || {};
      return `
        <a class="settlement-item" href="/settlement-detail.html?id=${item.id}">
          <div>
            <div class="settlement-range">${escapeHtml(item.startDate)} 至 ${escapeHtml(item.endDate)}</div>
            <div class="settlement-meta">生成于 ${escapeHtml(item.createdAt || "-")}</div>
          </div>
          <div class="settlement-item-stats">
            <span>推拿 ${formatNumber(summary.massageSessions)} 次</span>
            <span>充值 ${formatNumber(summary.rechargeSessions)} 次</span>
            <span>流水 ${formatNumber(summary.recordCount)} 条</span>
          </div>
          <span class="settlement-open">查看</span>
        </a>
      `;
    })
    .join("");
}

function validateDates() {
  const startDate = elements.startDateInput.value;
  const endDate = elements.endDateInput.value;
  const valid = Boolean(defaults.canCreate !== false && startDate && endDate && startDate <= endDate);
  elements.createButton.disabled = !valid;
  if (defaults.canCreate === false) {
    elements.createButton.title = "已经月结到今天，暂时没有新的日期可结算";
  } else if (startDate && endDate && startDate > endDate) {
    elements.createButton.title = "起始日期不能晚于结束日期";
  } else {
    elements.createButton.title = "";
  }
}

async function createSettlement() {
  const startDate = elements.startDateInput.value;
  const endDate = elements.endDateInput.value;
  if (!startDate || !endDate || startDate > endDate) {
    setStatus("请选择正确的起止日期", "error");
    return;
  }
  const confirmed = window.confirm(
    `确认生成 ${startDate} 至 ${endDate} 的月结单？\n生成后这段时间的流水和赊账情况将被冻结。`
  );
  if (!confirmed) return;

  elements.createButton.disabled = true;
  setStatus("正在生成月结快照");
  const requestKey = `tuina:settlement:${startDate}:${endDate}`;
  const requestId = persistentRequestId(requestKey);
  try {
    const response = await fetch("/api/settlements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate,
        endDate,
        requestId,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "生成月结单失败");
    sessionStorage.removeItem(requestKey);
    window.location.href = `/settlement-detail.html?id=${payload.settlement.id}`;
  } catch (error) {
    setStatus(error.message || String(error), "error");
    validateDates();
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

function setStatus(message, tone = "") {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", tone === "error");
  elements.status.classList.toggle("success", tone === "success");
}

function formatNumber(value) {
  const number = Number(value || 0);
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
