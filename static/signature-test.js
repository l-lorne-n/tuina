const elements = {
  padSummary: document.querySelector("#padSummary"),
  testNameInput: document.querySelector("#testNameInput"),
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
  signatureCanvas: document.querySelector("#signatureCanvas"),
  latestSignatureImage: document.querySelector("#latestSignatureImage"),
  latestSignatureEmpty: document.querySelector("#latestSignatureEmpty"),
  latestSignatureInfo: document.querySelector("#latestSignatureInfo"),
  latestSignatureLink: document.querySelector("#latestSignatureLink"),
  refreshTestsButton: document.querySelector("#refreshTestsButton"),
  testSignatureGrid: document.querySelector("#testSignatureGrid"),
};

const kindLabels = {
  directory: "目录签名",
  case: "病历签名 / 新患者签名",
  visit: "推拿签字 / 家长签字",
};

let canvasContext = null;
let pixelRatio = 1;
let activePointerId = null;
let currentStroke = null;
let strokes = [];

init();

async function init() {
  canvasContext = elements.signatureCanvas.getContext("2d", { alpha: false });
  bindEvents();
  resizeCanvas();
  await loadTestSignatures();
  setStatus("安全测试页已打开，保存不会绑定真实患者", "success");
}

function bindEvents() {
  elements.testNameInput.addEventListener("input", updateTitle);
  elements.clearButton.addEventListener("click", clearDrawing);
  elements.undoButton.addEventListener("click", undoStroke);
  elements.saveSignatureButton.addEventListener("click", saveSignature);
  elements.fullScreenButton.addEventListener("click", toggleFullscreenMode);
  elements.refreshTestsButton.addEventListener("click", loadTestSignatures);
  elements.signatureCanvas.addEventListener("pointerdown", startStroke);
  elements.signatureCanvas.addEventListener("pointermove", moveStroke);
  elements.signatureCanvas.addEventListener("pointerup", endStroke);
  elements.signatureCanvas.addEventListener("pointercancel", endStroke);
  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
}

function updateTitle() {
  const name = elements.testNameInput.value.trim() || "测试签名";
  elements.activePatientName.textContent = name;
  elements.activePatientMeta.textContent = "安全测试模式，不会修改真实患者数据库";
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
    // Pointer capture is optional; drawing still works without it.
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
  setStatus("等待测试签名");
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
        // Layout mode has already exited.
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
  if (!strokes.some((stroke) => stroke.points && stroke.points.length)) {
    setStatus("还没有签名，不能保存", "error");
    return;
  }

  elements.saveSignatureButton.disabled = true;
  setStatus("正在保存测试签名");
  try {
    const imageData = elements.signatureCanvas.toDataURL("image/png");
    const response = await fetch("/api/test-signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: elements.signatureKindSelect.value,
        testName: elements.testNameInput.value.trim(),
        signerName: elements.signerNameInput.value.trim(),
        note: elements.signatureNoteInput.value.trim(),
        imageData,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "保存失败");

    renderLatestSave(payload.signature);
    await loadTestSignatures();
    setStatus("测试签名已保存，不会绑定真实患者", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    elements.saveSignatureButton.disabled = false;
  }
}

function renderLatestSave(signature) {
  const imageUrl = `${signature.url}?v=${Date.now()}`;
  elements.latestSignatureImage.src = imageUrl;
  elements.latestSignatureImage.alt = `${elements.testNameInput.value.trim() || "测试签名"} ${
    kindLabels[signature.kind]
  }`;
  elements.latestSignatureImage.hidden = false;
  elements.latestSignatureEmpty.hidden = true;
  elements.latestSignatureInfo.textContent = `${kindLabels[signature.kind]} | ${
    signature.savedAt
  } | ${signature.filePath || signature.url}`;
  elements.latestSignatureLink.href = imageUrl;
  elements.latestSignatureLink.hidden = false;
}

async function loadTestSignatures() {
  try {
    const response = await fetch("/api/test-signatures", { cache: "no-store" });
    const payload = await response.json();
    const signatures = payload.ok ? payload.signatures || [] : [];
    renderTestGrid(signatures);
  } catch (error) {
    elements.testSignatureGrid.innerHTML = '<div class="empty-state">读取测试记录失败</div>';
  }
}

function renderTestGrid(signatures) {
  if (!signatures.length) {
    elements.testSignatureGrid.innerHTML = '<div class="empty-state">还没有测试签名</div>';
    return;
  }
  elements.testSignatureGrid.innerHTML = signatures
    .map((signature) => {
      const imageUrl = `${signature.url}?v=${encodeURIComponent(signature.savedAt || Date.now())}`;
      return `
        <a class="test-signature-card" href="${imageUrl}" target="_blank" rel="noreferrer">
          <img src="${imageUrl}" alt="${escapeHtml(kindLabels[signature.kind] || signature.kind)}" loading="lazy" />
          <span>${escapeHtml(kindLabels[signature.kind] || signature.kind)} · ${escapeHtml(
            signature.savedAt || ""
          )}</span>
        </a>
      `;
    })
    .join("");
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
