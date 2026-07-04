const elements = {
  padSummary: document.querySelector("#padSummary"),
  patientFilterInput: document.querySelector("#patientFilterInput"),
  patientSelect: document.querySelector("#patientSelect"),
  signatureKindSelect: document.querySelector("#signatureKindSelect"),
  signerNameInput: document.querySelector("#signerNameInput"),
  signatureNoteInput: document.querySelector("#signatureNoteInput"),
  clearButton: document.querySelector("#clearButton"),
  undoButton: document.querySelector("#undoButton"),
  saveSignatureButton: document.querySelector("#saveSignatureButton"),
  fullScreenButton: document.querySelector("#fullScreenButton"),
  pointerTypeText: document.querySelector("#pointerTypeText"),
  pressureText: document.querySelector("#pressureText"),
  saveStatus: document.querySelector("#saveStatus"),
  activePatientName: document.querySelector("#activePatientName"),
  activePatientMeta: document.querySelector("#activePatientMeta"),
  patientCardLink: document.querySelector("#patientCardLink"),
  signatureCanvas: document.querySelector("#signatureCanvas"),
  existingSignatureGrid: document.querySelector("#existingSignatureGrid"),
  latestSignatureImage: document.querySelector("#latestSignatureImage"),
  latestSignatureEmpty: document.querySelector("#latestSignatureEmpty"),
  latestSignatureInfo: document.querySelector("#latestSignatureInfo"),
  latestSignatureLink: document.querySelector("#latestSignatureLink"),
};

const kindLabels = {
  directory: "目录签名",
  case: "病历签名 / 新患者签名",
  visit: "推拿签字 / 家长签字",
};

const slotLabels = [
  ["directorySignature", "目录签名"],
  ["caseSignature", "病历签名"],
  ["visitSignature", "推拿签字"],
];

let patients = [];
let selectedPatient = null;
let signatureItemsByPatientId = new Map();
let signatureManifestVersion = "";
let canvasContext = null;
let pixelRatio = 1;
let activePointerId = null;
let currentStroke = null;
let strokes = [];
let returnToUrl = "";

init();

async function init() {
  canvasContext = elements.signatureCanvas.getContext("2d", { alpha: false });
  bindEvents();
  resizeCanvas();
  await Promise.all([loadPatients(), loadSignatureManifest()]);

  const params = new URLSearchParams(window.location.search);
  returnToUrl = safeReturnTo(params.get("returnTo") || "");
  const requestedNote = params.get("note");
  if (requestedNote) {
    elements.signatureNoteInput.value = requestedNote;
  }
  const requestedKind = params.get("kind");
  if (requestedKind && kindLabels[requestedKind]) {
    elements.signatureKindSelect.value = requestedKind;
  }
  const requestedId = Number(params.get("patientId") || 0);
  renderPatientOptions(requestedId);
  const initialPatient =
    patients.find((patient) => Number(patient.id) === requestedId) || patients[0] || null;
  if (initialPatient) {
    selectPatient(initialPatient.id);
  } else {
    setStatus("没有读到患者名单", "error");
  }
}

function bindEvents() {
  elements.patientFilterInput.addEventListener("input", () => {
    renderPatientOptions(selectedPatient ? selectedPatient.id : 0);
  });
  elements.patientSelect.addEventListener("change", () => {
    selectPatient(Number(elements.patientSelect.value || 0));
  });
  elements.clearButton.addEventListener("click", clearDrawing);
  elements.undoButton.addEventListener("click", undoStroke);
  elements.saveSignatureButton.addEventListener("click", saveSignature);
  elements.fullScreenButton.addEventListener("click", toggleFullscreenMode);
  elements.signatureCanvas.addEventListener("pointerdown", startStroke);
  elements.signatureCanvas.addEventListener("pointermove", moveStroke);
  elements.signatureCanvas.addEventListener("pointerup", endStroke);
  elements.signatureCanvas.addEventListener("pointercancel", endStroke);
  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
}

async function loadPatients() {
  const response = await fetch("/api/patients", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取患者失败");
  patients = payload.patients || [];
  elements.padSummary.textContent = `共 ${patients.length} 人，可选择患者后签名保存`;
}

async function loadSignatureManifest() {
  const response = await fetch("/api/signature-manifest", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) return;
  const manifest = payload.manifest || {};
  signatureManifestVersion = encodeURIComponent(
    manifest.bindingUpdatedAt || manifest.generatedAt || Date.now()
  );
  signatureItemsByPatientId = new Map(
    (manifest.items || []).map((item) => [Number(item.patientId), item])
  );
}

function renderPatientOptions(preferredId = 0) {
  const query = elements.patientFilterInput.value.trim();
  const visible = patients.filter((patient) => {
    if (!query) return true;
    return `${patient.order}${patient.name}${patient.originalName || ""}${patient.phone || ""}`.includes(
      query
    );
  });

  elements.patientSelect.innerHTML = "";
  if (!visible.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有匹配患者";
    elements.patientSelect.appendChild(option);
    return;
  }

  for (const patient of visible) {
    const option = document.createElement("option");
    option.value = patient.id;
    option.textContent = `${String(patient.order).padStart(3, "0")} ${patient.name}`;
    elements.patientSelect.appendChild(option);
  }

  const hasPreferred = visible.some((patient) => Number(patient.id) === Number(preferredId));
  elements.patientSelect.value = hasPreferred ? String(preferredId) : String(visible[0].id);
  if (!hasPreferred) {
    selectPatient(Number(elements.patientSelect.value || 0));
  }
}

function selectPatient(patientId) {
  const patient = patients.find((item) => Number(item.id) === Number(patientId));
  if (!patient) return;
  selectedPatient = patient;
  elements.patientSelect.value = String(patient.id);
  elements.activePatientName.textContent = patient.name;
  elements.activePatientMeta.textContent = `第 ${patient.order} 位，剩余 ${
    patient.remainingSessions ?? "-"
  } 次，电话 ${patient.phone || "-"}`;
  elements.patientCardLink.href = `/patient-search.html?patientId=${patient.id}`;
  elements.patientCardLink.textContent = "打开患者卡片";
  if (returnToUrl) {
    elements.patientCardLink.href = returnToUrl;
    elements.patientCardLink.textContent = "返回次数管理";
  }
  renderExistingSignatures();
  clearDrawing();
}

function renderExistingSignatures() {
  if (!selectedPatient) {
    elements.existingSignatureGrid.innerHTML = "";
    return;
  }

  const item = signatureItemsByPatientId.get(Number(selectedPatient.id));
  elements.existingSignatureGrid.innerHTML = slotLabels
    .map(([key, label]) => {
      const url = item && item[key] ? `${item[key]}?v=${signatureManifestVersion}` : "";
      return `
        <div class="signature-preview-item">
          <div class="signature-preview-title">${label}</div>
          <div class="signature-preview-image">
            ${
              url
                ? `<a href="${url}" target="_blank" rel="noreferrer"><img src="${url}" alt="${escapeHtml(
                    selectedPatient.name
                  )} ${label}" /></a>`
                : '<span class="signature-preview-empty">未绑定</span>'
            }
          </div>
        </div>
      `;
    })
    .join("");
}

function resizeCanvas() {
  const rect = elements.signatureCanvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || 900));
  const height = Math.max(220, Math.round(rect.height || 340));
  pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  elements.signatureCanvas.width = Math.round(width * pixelRatio);
  elements.signatureCanvas.height = Math.round(height * pixelRatio);
  canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  redrawCanvas();
}

function startStroke(event) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  try {
    elements.signatureCanvas.setPointerCapture(event.pointerId);
  } catch (error) {
    // Some browsers do not allow capture in every pointer state.
  }
  currentStroke = { points: [] };
  strokes.push(currentStroke);
  appendPoint(pointFromEvent(event));
  updateDeviceState(event);
}

function moveStroke(event) {
  if (event.pointerId !== activePointerId || !currentStroke) return;
  event.preventDefault();
  const events =
    typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
  for (const pointerEvent of events) {
    appendPoint(pointFromEvent(pointerEvent));
  }
  updateDeviceState(event);
}

function endStroke(event) {
  if (activePointerId !== event.pointerId) return;
  event.preventDefault();
  try {
    elements.signatureCanvas.releasePointerCapture(event.pointerId);
  } catch (error) {
    // Capture may already be released.
  }
  activePointerId = null;
  currentStroke = null;
  updateDeviceState(event);
}

function appendPoint(point) {
  if (!currentStroke) return;
  const previous = currentStroke.points[currentStroke.points.length - 1];
  if (previous && distance(previous, point) < 0.35) return;
  currentStroke.points.push(point);
  if (previous) {
    drawSegment(previous, point);
  } else {
    drawDot(point);
  }
}

function pointFromEvent(event) {
  const rect = elements.signatureCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    pressure: normalizePressure(event),
  };
}

function normalizePressure(event) {
  let pressure = typeof event.pressure === "number" ? event.pressure : 0.5;
  if (pressure <= 0 && event.buttons) pressure = 0.5;
  return Math.min(1, Math.max(0.08, pressure || 0.5));
}

function pressureToWidth(pressure) {
  return 2.2 + pressure * 5.8;
}

function drawSegment(previous, point) {
  const pressure = (previous.pressure + point.pressure) / 2;
  canvasContext.lineCap = "round";
  canvasContext.lineJoin = "round";
  canvasContext.strokeStyle = "#111827";
  canvasContext.lineWidth = pressureToWidth(pressure);
  canvasContext.beginPath();
  canvasContext.moveTo(previous.x, previous.y);
  canvasContext.lineTo(point.x, point.y);
  canvasContext.stroke();
}

function drawDot(point) {
  const radius = pressureToWidth(point.pressure) / 2;
  canvasContext.fillStyle = "#111827";
  canvasContext.beginPath();
  canvasContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
  canvasContext.fill();
}

function redrawCanvas() {
  canvasContext.save();
  canvasContext.fillStyle = "#fff";
  canvasContext.fillRect(0, 0, elements.signatureCanvas.width, elements.signatureCanvas.height);
  canvasContext.restore();

  for (const stroke of strokes) {
    const points = stroke.points || [];
    if (!points.length) continue;
    drawDot(points[0]);
    for (let index = 1; index < points.length; index += 1) {
      drawSegment(points[index - 1], points[index]);
    }
  }
}

function clearDrawing() {
  strokes = [];
  currentStroke = null;
  activePointerId = null;
  redrawCanvas();
  setStatus("等待签名");
}

function undoStroke() {
  strokes.pop();
  redrawCanvas();
  setStatus(strokes.length ? "已撤销上一笔" : "已清空");
}

async function toggleFullscreenMode() {
  const entering = !document.body.classList.contains("signing-fullscreen");
  if (entering) {
    document.body.classList.add("signing-fullscreen");
    elements.fullScreenButton.textContent = "退出全屏";
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      setStatus("已进入全屏大画布，按 Esc 或点“退出全屏”可返回", "success");
    } catch (error) {
      setStatus("已切换到浏览器窗口内的大画布；浏览器未允许真正全屏", "success");
    }
  } else {
    document.body.classList.remove("signing-fullscreen");
    elements.fullScreenButton.textContent = "全屏签名";
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        // The layout mode has already been exited; browser fullscreen can fail silently.
      }
    }
    setStatus("已退出全屏签名");
  }
  window.setTimeout(resizeCanvas, 80);
}

function handleFullscreenChange() {
  if (!document.fullscreenElement && document.body.classList.contains("signing-fullscreen")) {
    document.body.classList.remove("signing-fullscreen");
    elements.fullScreenButton.textContent = "全屏签名";
    window.setTimeout(resizeCanvas, 80);
  }
}

async function saveSignature() {
  if (!selectedPatient) {
    setStatus("请先选择患者", "error");
    return;
  }
  if (!strokes.some((stroke) => stroke.points && stroke.points.length)) {
    setStatus("还没有签名，不能保存", "error");
    return;
  }

  elements.saveSignatureButton.disabled = true;
  setStatus("正在保存签名");
  try {
    const imageData = elements.signatureCanvas.toDataURL("image/png");
    const response = await fetch("/api/signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: selectedPatient.id,
        kind: elements.signatureKindSelect.value,
        signerName: elements.signerNameInput.value.trim(),
        note: elements.signatureNoteInput.value.trim(),
        imageData,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "保存失败");

    await loadSignatureManifest();
    renderExistingSignatures();
    renderLatestSave(payload.signature);
    setStatus(
      `已保存到电脑，并已绑定到患者卡片${returnToUrl ? "，可点右上角返回次数管理" : ""}`,
      "success"
    );
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.saveSignatureButton.disabled = false;
  }
}

function renderLatestSave(signature) {
  const imageUrl = `${signature.url}?v=${Date.now()}`;
  elements.latestSignatureImage.src = imageUrl;
  elements.latestSignatureImage.alt = `${selectedPatient.name} ${kindLabels[signature.kind]}`;
  elements.latestSignatureImage.hidden = false;
  elements.latestSignatureEmpty.hidden = true;
  elements.latestSignatureInfo.textContent = `${kindLabels[signature.kind]} | ${
    signature.savedAt
  } | ${signature.filePath || signature.url}`;
  elements.latestSignatureLink.href = imageUrl;
  elements.latestSignatureLink.hidden = false;
}

function updateDeviceState(event) {
  elements.pointerTypeText.textContent = pointerTypeLabel(event.pointerType);
  elements.pressureText.textContent =
    typeof event.pressure === "number" ? event.pressure.toFixed(2) : "-";
}

function pointerTypeLabel(type) {
  if (type === "pen") return "笔";
  if (type === "touch") return "触控";
  if (type === "mouse") return "鼠标";
  return type || "未知";
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function setStatus(message, tone = "") {
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.toggle("error", tone === "error");
  elements.saveStatus.classList.toggle("success", tone === "success");
}

function safeReturnTo(value) {
  if (!value || !value.startsWith("/")) return "";
  if (value.startsWith("//")) return "";
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
