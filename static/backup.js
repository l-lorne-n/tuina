const elements = {
  statusText: document.querySelector("#backupStatusText"),
  badge: document.querySelector("#backupBadge"),
  backupNowButton: document.querySelector("#backupNowButton"),
  refreshButton: document.querySelector("#refreshBackupButton"),
  lastSuccessValue: document.querySelector("#lastSuccessValue"),
  lastRemoteValue: document.querySelector("#lastRemoteValue"),
  lastSignatureValue: document.querySelector("#lastSignatureValue"),
  lastSizeValue: document.querySelector("#lastSizeValue"),
};

init();

function init() {
  elements.backupNowButton.addEventListener("click", runBackupNow);
  elements.refreshButton.addEventListener("click", loadBackupStatus);
  loadBackupStatus();
}

async function loadBackupStatus() {
  setStatus("正在读取备份状态", "running");
  try {
    const response = await fetch("/api/backup-status", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "读取备份状态失败");
    renderBackup(payload.backup || {});
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

async function runBackupNow() {
  elements.backupNowButton.disabled = true;
  setStatus("正在手动增量备份", "running");
  try {
    const response = await fetch("/api/backup-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "备份失败");
    renderBackup(payload.backup || {});
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.backupNowButton.disabled = false;
  }
}

function renderBackup(backup) {
  const state = backup.state || "idle";
  const message = backup.message || "云备份待检查";
  setStatus(message, state);
  elements.lastSuccessValue.textContent = backup.lastSuccessAt || "-";
  elements.lastRemoteValue.textContent = backup.lastRemoteName || "-";
  elements.lastSignatureValue.textContent = `${backup.lastIncludedSignatures || 0} 张`;
  elements.lastSizeValue.textContent = formatBytes(backup.lastPackageBytes || 0);
}

function setStatus(message, state = "idle") {
  elements.statusText.textContent = message;
  elements.badge.textContent = message;
  elements.badge.classList.remove("success", "running", "error");
  if (["success", "running", "error"].includes(state)) elements.badge.classList.add(state);
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(2)} MB`;
}
