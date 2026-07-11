const TARGET_SAMPLE_RATE = 16000;
const MAX_SECONDS = 60;
const WARN_SECONDS = 55;

const elements = {
  configText: document.querySelector("#configText"),
  totalText: document.querySelector("#totalText"),
  doneText: document.querySelector("#doneText"),
  reviewText: document.querySelector("#reviewText"),
  searchInput: document.querySelector("#searchInput"),
  newPatientButton: document.querySelector("#newPatientButton"),
  exportButton: document.querySelector("#exportButton"),
  patientList: document.querySelector("#patientList"),
  orderText: document.querySelector("#orderText"),
  nameInput: document.querySelector("#nameInput"),
  prevButton: document.querySelector("#prevButton"),
  nextButton: document.querySelector("#nextButton"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  parseButton: document.querySelector("#parseButton"),
  levelBar: document.querySelector("#levelBar"),
  timerText: document.querySelector("#timerText"),
  statusText: document.querySelector("#statusText"),
  rawTranscriptInput: document.querySelector("#rawTranscriptInput"),
  genderInput: document.querySelector("#genderInput"),
  ageInput: document.querySelector("#ageInput"),
  phoneInput: document.querySelector("#phoneInput"),
  weightInput: document.querySelector("#weightInput"),
  heightInput: document.querySelector("#heightInput"),
  remainingInput: document.querySelector("#remainingInput"),
  addressInput: document.querySelector("#addressInput"),
  recordNoInput: document.querySelector("#recordNoInput"),
  notesInput: document.querySelector("#notesInput"),
  signaturePadLink: document.querySelector("#signaturePadLink"),
  entrySignaturePreview: document.querySelector("#entrySignaturePreview"),
  rechargeRows: document.querySelector("#rechargeRows"),
  rechargeTemplate: document.querySelector("#rechargeTemplate"),
  addRechargeButton: document.querySelector("#addRechargeButton"),
  reviewButton: document.querySelector("#reviewButton"),
  saveButton: document.querySelector("#saveButton"),
  saveNextButton: document.querySelector("#saveNextButton"),
};

let patients = [];
let currentPatient = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let mediaStream = null;
let audioChunks = [];
let startedAt = 0;
let timerId = 0;
let currentSampleRate = 0;
let recording = false;
let signatureItemsByPatientId = new Map();
let signatureManifestVersion = "";

init();

async function init() {
  bindEvents();
  await loadConfig();
  await loadSignatureManifest();
  await loadPatients();
  const requestedId = Number(new URLSearchParams(window.location.search).get("patientId") || 0);
  const requestedPatient = requestedId ? patients.find((patient) => patient.id === requestedId) : null;
  const firstOpen = requestedPatient || patients.find((patient) => patient.status !== "completed") || patients[0];
  if (firstOpen) {
    await selectPatient(firstOpen.id);
  }
}

function bindEvents() {
  elements.searchInput.addEventListener("input", renderPatientList);
  elements.newPatientButton.addEventListener("click", createNewPatient);
  elements.exportButton.addEventListener("click", () => {
    window.location.href = "/api/export.csv";
  });
  elements.prevButton.addEventListener("click", () => moveBy(-1));
  elements.nextButton.addEventListener("click", () => moveBy(1));
  elements.startButton.addEventListener("click", startRecording);
  elements.stopButton.addEventListener("click", () => stopAndRecognize());
  elements.parseButton.addEventListener("click", parseTranscript);
  elements.addRechargeButton.addEventListener("click", () => addRechargeRow());
  elements.saveButton.addEventListener("click", () => saveCurrent("pending", false));
  elements.saveNextButton.addEventListener("click", () => saveCurrent("completed", true));
  elements.reviewButton.addEventListener("click", () => saveCurrent("review", true));
}

async function createNewPatient() {
  const response = await fetch("/api/patients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "新建卡片" }),
  });
  const payload = await response.json();
  if (!payload.ok) {
    setStatus(payload.error || "新建卡片失败", true);
    return;
  }
  elements.searchInput.value = "";
  await loadPatients();
  await selectPatient(payload.patient.id);
  elements.nameInput.focus();
  elements.nameInput.select();
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const payload = await response.json();
    const config = payload.config || {};
    const credentialText = config.hasCredentials === "true" ? "密钥已配置" : "密钥未配置";
    const hotwordText = config.hotwordId ? "，热词已配置" : "";
    elements.configText.textContent = `${credentialText}，引擎 ${config.engine || "-"}，区域 ${config.region || "-"}${hotwordText}`;
  } catch (error) {
    elements.configText.textContent = "配置读取失败";
  }
}

async function loadPatients() {
  const response = await fetch("/api/patients", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取名单失败");
  patients = payload.patients || [];
  updateSummary();
  renderPatientList();
}

async function loadSignatureManifest() {
  try {
    const response = await fetch("/api/signature-manifest", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) return;
    const manifest = payload.manifest || {};
    signatureManifestVersion = encodeURIComponent(manifest.generatedAt || Date.now());
    signatureItemsByPatientId = new Map(
      (manifest.items || []).map((item) => [Number(item.patientId), item])
    );
  } catch (error) {
    signatureItemsByPatientId = new Map();
  }
}

function updateSummary() {
  const done = patients.filter((patient) => patient.status === "completed").length;
  const review = patients.filter((patient) => patient.status === "review").length;
  elements.totalText.textContent = `${patients.length} 人`;
  elements.doneText.textContent = `${done} 已录`;
  elements.reviewText.textContent = `${review} 复核`;
}

function renderPatientList() {
  const query = elements.searchInput.value.trim();
  const visible = patients.filter((patient) => {
    if (!query) return true;
    return `${patient.name}${patient.originalName}${patient.phone || ""}${patient.address || ""}${
      patient.recordNo ?? ""
    }`.includes(query);
  });
  elements.patientList.innerHTML = "";
  if (!visible.length) {
    elements.patientList.innerHTML = '<div class="empty-state">没有匹配的人名</div>';
    return;
  }
  for (const patient of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `patient-row${currentPatient && currentPatient.id === patient.id ? " active" : ""}`;
    button.dataset.id = patient.id;
    button.innerHTML = `
      <span class="order">${String(patient.order).padStart(2, "0")}</span>
      <span class="name">${escapeHtml(patient.name)}</span>
      <span class="badge ${patient.status}">${statusLabel(patient.status)}</span>
    `;
    button.addEventListener("click", () => selectPatient(patient.id));
    elements.patientList.appendChild(button);
  }
}

function statusLabel(status) {
  if (status === "completed") return "已录";
  if (status === "review") return "复核";
  return "未录";
}

async function selectPatient(id) {
  const response = await fetch(`/api/patients/${id}`, { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || "读取卡片失败");
  currentPatient = payload.patient;
  fillForm(currentPatient);
  renderPatientList();
}

function fillForm(patient) {
  elements.orderText.textContent = `第 ${patient.order} 位，原姓名：${patient.originalName}`;
  elements.nameInput.value = patient.name || "";
  elements.genderInput.value = patient.gender || "";
  elements.ageInput.value = patient.age || "";
  elements.phoneInput.value = patient.phone || "";
  elements.weightInput.value = patient.weight || "";
  elements.heightInput.value = patient.height || "";
  elements.remainingInput.value = patient.remainingSessions ?? "";
  elements.addressInput.value = patient.address || "";
  elements.recordNoInput.value = patient.recordNo ?? "";
  elements.notesInput.value = patient.notes || "";
  elements.rawTranscriptInput.value = patient.rawTranscript || "";
  elements.rechargeRows.innerHTML = "";
  for (const recharge of patient.recharges || []) {
    addRechargeRow(recharge);
  }
  if (!patient.recharges || !patient.recharges.length) {
    addRechargeRow();
  }
  updateSignaturePadLink(patient);
  renderSignaturePreview(patient);
  setStatus("待录音");
}

function updateSignaturePadLink(patient) {
  if (!elements.signaturePadLink) return;
  elements.signaturePadLink.href = `/signature-pad.html?patientId=${patient.id}&kind=visit`;
}

function renderSignaturePreview(patient) {
  if (!elements.entrySignaturePreview) return;
  const item = signatureItemsByPatientId.get(Number(patient.id));
  const slots = [
    ["directorySignature", "目录签名"],
    ["caseSignature", "病历签名"],
    ["visitSignature", "推拿签字"],
  ];
  elements.entrySignaturePreview.innerHTML = slots
    .map(([key, label]) => {
      const url = item && item[key] ? `${item[key]}?v=${signatureManifestVersion}` : "";
      return `
        <div class="signature-preview-item">
          <div class="signature-preview-title">${label}</div>
          <div class="signature-preview-image">
            ${
              url
                ? `<img src="${url}" alt="${escapeHtml(patient.name)} ${label}" />`
                : '<span class="signature-preview-empty">未绑定</span>'
            }
          </div>
        </div>
      `;
    })
    .join("");
}

function addRechargeRow(recharge = {}) {
  const fragment = elements.rechargeTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".recharge-row");
  row.querySelector(".recharge-date").value = recharge.date || "";
  row.querySelector(".recharge-amount").value = recharge.amount ?? "";
  row.querySelector(".recharge-sessions").value = recharge.sessions ?? "";
  row.querySelector(".recharge-raw").value = recharge.rawText || "";
  row.querySelector(".remove-recharge").addEventListener("click", () => row.remove());
  elements.rechargeRows.appendChild(row);
}

function collectPayload(status) {
  return {
    name: elements.nameInput.value.trim(),
    gender: elements.genderInput.value,
    age: elements.ageInput.value.trim(),
    phone: elements.phoneInput.value.trim(),
    weight: elements.weightInput.value.trim(),
    height: elements.heightInput.value.trim(),
    remainingSessions: elements.remainingInput.value.trim(),
    address: elements.addressInput.value.trim(),
    recordNo: elements.recordNoInput.value.trim(),
    notes: elements.notesInput.value.trim(),
    rawTranscript: elements.rawTranscriptInput.value.trim(),
    status,
    recharges: [...elements.rechargeRows.querySelectorAll(".recharge-row")].map((row) => ({
      date: row.querySelector(".recharge-date").value.trim(),
      amount: row.querySelector(".recharge-amount").value.trim(),
      sessions: row.querySelector(".recharge-sessions").value.trim(),
      rawText: row.querySelector(".recharge-raw").value.trim(),
    })),
  };
}

async function saveCurrent(status, goNext) {
  if (!currentPatient) return;
  setStatus("保存中");
  const response = await fetch(`/api/patients/${currentPatient.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collectPayload(status)),
  });
  const payload = await response.json();
  if (!payload.ok) {
    setStatus(payload.error || "保存失败", true);
    return;
  }
  currentPatient = payload.patient;
  await loadPatients();
  setStatus("已保存");
  if (goNext) {
    await moveBy(1);
  } else {
    await selectPatient(currentPatient.id);
  }
}

async function moveBy(offset) {
  if (!patients.length) return;
  const index = currentPatient
    ? patients.findIndex((patient) => patient.id === currentPatient.id)
    : 0;
  const nextIndex = Math.min(Math.max(index + offset, 0), patients.length - 1);
  await selectPatient(patients[nextIndex].id);
}

async function parseTranscript() {
  const text = elements.rawTranscriptInput.value.trim();
  if (!text) {
    setStatus("没有可解析的文本", true);
    return;
  }
  setStatus("解析中");
  const response = await fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const payload = await response.json();
  if (!payload.ok) {
    setStatus(payload.error || "解析失败", true);
    return;
  }
  applyParsed(payload.parsed || {});
  setStatus("已解析，请核对后保存");
}

function applyParsed(parsed) {
  const fields = parsed.fields || {};
  if (fields.gender) elements.genderInput.value = fields.gender;
  if (fields.age) elements.ageInput.value = fields.age;
  if (fields.phone) elements.phoneInput.value = fields.phone;
  if (fields.weight) elements.weightInput.value = fields.weight;
  if (fields.height) elements.heightInput.value = fields.height;
  if (fields.address && [...elements.addressInput.options].some((option) => option.value === fields.address)) {
    elements.addressInput.value = fields.address;
  }
  if (fields.remainingSessions !== null && fields.remainingSessions !== undefined) {
    elements.remainingInput.value = fields.remainingSessions;
  }
  if (Array.isArray(parsed.recharges) && parsed.recharges.length) {
    elements.rechargeRows.innerHTML = "";
    for (const recharge of parsed.recharges) {
      addRechargeRow(recharge);
    }
  }
}

async function startRecording() {
  try {
    setStatus("准备录音");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioContext = new AudioContext();
    currentSampleRate = audioContext.sampleRate;
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    audioChunks = [];

    processorNode.onaudioprocess = (event) => {
      if (!recording) return;
      const input = event.inputBuffer.getChannelData(0);
      audioChunks.push(new Float32Array(input));
      updateLevel(input);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    recording = true;
    startedAt = Date.now();
    startTimer();
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setStatus("录音中");
  } catch (error) {
    cleanupAudio();
    setStatus(microphoneError(error), true);
  }
}

async function stopAndRecognize() {
  if (!recording) return;
  const elapsedSeconds = elapsed();
  const wavBlob = buildWavBlob();
  cleanupAudio();
  stopTimer();
  elements.timerText.textContent = formatSeconds(elapsedSeconds);
  elements.levelBar.style.width = "0%";
  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  setStatus("识别中");

  try {
    const audioBase64 = await blobToBase64(wavBlob);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64, durationSeconds: elapsedSeconds }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "识别失败");
    elements.rawTranscriptInput.value = payload.text || "";
    await parseTranscript();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

function buildWavBlob() {
  const merged = mergeChunks(audioChunks);
  const downsampled = downsampleBuffer(merged, currentSampleRate, TARGET_SAMPLE_RATE);
  const wavBuffer = encodeWav(downsampled, TARGET_SAMPLE_RATE);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

function mergeChunks(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function downsampleBuffer(buffer, sampleRate, outSampleRate) {
  if (outSampleRate === sampleRate) return buffer;
  if (outSampleRate > sampleRate) {
    throw new Error("目标采样率不能高于原始采样率。");
  }
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i += 1) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function cleanupAudio() {
  recording = false;
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
  }
  if (sourceNode) sourceNode.disconnect();
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  if (audioContext) audioContext.close();
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  mediaStream = null;
}

function startTimer() {
  stopTimer();
  timerId = window.setInterval(() => {
    const seconds = elapsed();
    elements.timerText.textContent = formatSeconds(seconds);
    if (seconds >= WARN_SECONDS && seconds < MAX_SECONDS) {
      setStatus("接近 60 秒上限");
    }
    if (seconds >= MAX_SECONDS) {
      stopAndRecognize();
    }
  }, 200);
}

function stopTimer() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = 0;
  }
}

function elapsed() {
  return startedAt ? (Date.now() - startedAt) / 1000 : 0;
}

function updateLevel(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += input[i] * input[i];
  }
  const rms = Math.sqrt(sum / input.length);
  const level = Math.min(100, Math.round(rms * 460));
  elements.levelBar.style.width = `${level}%`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function formatSeconds(seconds) {
  const total = Math.floor(seconds);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function microphoneError(error) {
  if (error && error.name === "NotAllowedError") {
    return "无法访问麦克风，请在浏览器设置中允许本页使用麦克风。";
  }
  if (error && error.name === "NotFoundError") {
    return "没有检测到可用麦克风。";
  }
  return error && error.message ? error.message : "录音初始化失败。";
}

function setStatus(text, isError = false) {
  elements.statusText.textContent = text;
  elements.statusText.classList.toggle("error", Boolean(isError));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
