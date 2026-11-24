const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHARACTERISTIC = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const UART_RX_CHARACTERISTIC = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let bleDevice = null;
let bleServer = null;
let uartRxChar = null;
let gattBusy = false;
let connecting = false;
let tmModel = null;
let webcamStream = null;
let predictionInterval = null;
let inferenceBusy = false;
let gattOperation = 0;
let sendIntervalMs = 2000;
let confidenceThreshold = 0.8;
let facingMode = "environment";
let lastPrediction = null;
let sessionGeneration = 0;
let cameraGeneration = 0;
let modelGeneration = 0;

const el = (id) => document.getElementById(id);
const video = el("video");

function getTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function log(message, type = "") {
  const line = document.createElement("div");
  line.className = `log-entry ${type}`.trim();
  line.textContent = `[${getTime()}] ${message}`;
  el("activityLog").appendChild(line);
  el("activityLog").scrollTop = el("activityLog").scrollHeight;
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  el("toastStack").appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function setStatus(id, state, detail) {
  const node = el(id);
  node.className = `status-pill ${state}`;
  node.querySelector("span").textContent = detail;
}

function setLoading(button, loading) {
  button.classList.toggle("loading", loading);
  button.disabled = loading;
}

function sanitizePayload(value) {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
}

async function handleConnect() {
  if (!navigator.bluetooth) {
    const message = "Web Bluetooth needs Chrome or Edge on HTTPS.";
    log(message, "warn");
    toast(message, "warning");
    return;
  }

  if (connecting) return;
  if (uartRxChar && bleDevice?.gatt?.connected) {
    toast("Device already connected");
    return;
  }
  uartRxChar = null;
  bleServer = null;

  connecting = true;
  const generation = sessionGeneration;
  let device = null;
  setStatus("bleStatus", "loading", "Connecting");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "BBC micro:bit" }],
      optionalServices: [UART_SERVICE_UUID],
    });
    if (generation !== sessionGeneration) {
      if (device.gatt?.connected) device.gatt.disconnect();
      return;
    }

    device.addEventListener("gattserverdisconnected", onBleDisconnected);
    const server = await device.gatt.connect();
    if (generation !== sessionGeneration) {
      device.removeEventListener("gattserverdisconnected", onBleDisconnected);
      device.gatt.disconnect();
      return;
    }
    bleDevice = device;
    bleServer = server;

    log(`Connecting to ${device.name || "micro:bit"}…`);

    const uartService = await server.getPrimaryService(UART_SERVICE_UUID);
    uartRxChar = await uartService.getCharacteristic(UART_RX_CHARACTERISTIC);

    await new Promise((resolve) => setTimeout(resolve, 400));
    if (generation !== sessionGeneration || !device.gatt.connected) return;

    try {
      const txChar = await uartService.getCharacteristic(UART_TX_CHARACTERISTIC);
      await txChar.startNotifications();
      txChar.addEventListener("characteristicvaluechanged", (event) => {
        const message = new TextDecoder().decode(event.target.value);
        log(`← micro:bit: ${message}`, "success");
      });
    } catch (error) {
      if (generation !== sessionGeneration || !device.gatt.connected) return;
      log(`Notification subscription warning: ${error.message}`, "warn");
      toast("Connected, but device messages may not arrive", "warning");
    }

    if (generation !== sessionGeneration) return;
    el("connectButton").classList.add("connected");
    el("connectButton").querySelector(".connect-icon").textContent = "✓";
    el("connectButton").querySelector(".connect-label").textContent = "Connected";
    setStatus("bleStatus", "online", "Connected");
    log("Bluetooth UART connected", "success");
    toast("Micro:bit connected");
  } catch (error) {
    if (generation === sessionGeneration) {
      if (device) {
        device.removeEventListener("gattserverdisconnected", onBleDisconnected);
        if (device.gatt?.connected) device.gatt.disconnect();
      }
      if (!device || bleDevice === device) {
        bleDevice = null;
        bleServer = null;
        uartRxChar = null;
      }
      setStatus("bleStatus", "offline", "Offline");
      log(`Bluetooth error: ${error.message}`, "error");
      toast("Could not connect to the micro:bit", "error");
    }
  } finally {
    if (generation === sessionGeneration) connecting = false;
  }
}

function onBleDisconnected() {
  sessionGeneration++;
  uartRxChar = null;
  bleDevice = null;
  bleServer = null;
  connecting = false;
  el("connectButton").classList.remove("connected");
  el("connectButton").querySelector(".connect-icon").textContent = "+";
  el("connectButton").querySelector(".connect-label").textContent = "Connect device";
  setStatus("bleStatus", "offline", "Offline");
  log("Bluetooth disconnected", "warn");
  toast("Micro:bit disconnected", "warning");
}

async function sendString(rawValue) {
  if (gattBusy) {
    log("UART busy — command skipped", "warn");
    return false;
  }
  if (!uartRxChar) {
    log("Cannot send: Bluetooth disconnected", "warn");
    toast("Connect the micro:bit first", "warning");
    return false;
  }

  const value = sanitizePayload(String(rawValue));
  if (!value) {
    log("Cannot send an empty command", "warn");
    return false;
  }

  gattBusy = true;
  const operation = ++gattOperation;
  const generation = sessionGeneration;
  const characteristic = uartRxChar;
  try {
    const data = new TextEncoder().encode(`${value}\n`);
    for (let i = 0; i < data.length; i += 20) {
      if (generation !== sessionGeneration) return false;
      await characteristic.writeValueWithoutResponse(data.slice(i, i + 20));
      if (i + 20 < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (generation !== sessionGeneration) return false;
    log(`→ micro:bit: ${value}`, "success");
    if (el("audioToggle").checked) playFeedback();
    return true;
  } catch (error) {
    log(`UART send failed: ${error.message}`, "error");
    if (generation === sessionGeneration && error.message && error.message.toLowerCase().includes("disconnected")) {
      uartRxChar = null;
      setStatus("bleStatus", "offline", "Disconnected");
    }
    if (generation === sessionGeneration) toast("Command could not be sent", "error");
    return false;
  } finally {
    if (operation === gattOperation) gattBusy = false;
  }
}

function validateModelUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const allowed = url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "teachablemachine.withgoogle.com" || url.hostname === "storage.googleapis.com");
    return allowed ? `${url.href.replace(/\/?$/, "/")}` : null;
  } catch {
    return null;
  }
}

async function loadModel() {
  if (typeof tmImage === "undefined") {
    toast("Recognition library did not load", "error");
    return;
  }

  const url = validateModelUrl(el("modelUrl").value.trim());
  if (!url) {
    log("Invalid model URL — HTTPS Teachable Machine export required", "error");
    toast("Use a valid Teachable Machine HTTPS export URL", "error");
    return;
  }

  const button = el("loadButton");
  setLoading(button, true);
  el("loadButton").querySelector(".load-label").textContent = "Loading";
  setStatus("mlStatus", "loading", "Loading");
  const generation = modelGeneration;

  try {
    const loadedModel = await tmImage.load(`${url}model.json`, `${url}metadata.json`);
    if (generation !== modelGeneration) return;
    tmModel = loadedModel;
    const classLabels = loadedModel.getClassLabels();
    log(`Model loaded: ${loadedModel.getTotalClasses()} classes`);
    log(`Classes: ${classLabels.join(", ")}`, "success");
    setStatus("mlStatus", "online", "Ready");
    el("loadButton").querySelector(".load-label").textContent = "Reload model";
    renderProbabilityBars(classLabels);
    await startCamera();
  } catch (error) {
    if (generation === modelGeneration) {
      setStatus("mlStatus", tmModel ? "online" : "offline", tmModel ? "Ready" : "Error");
      log(`Model load failed: ${error.message}`, "error");
      toast("The model could not be loaded", "error");
    }
  } finally {
    if (generation === modelGeneration) {
      setLoading(button, false);
      if (tmModel) el("loadButton").querySelector(".load-label").textContent = "Reload model";
    }
  }
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Camera access is unavailable", "error");
    return;
  }

  const generation = ++cameraGeneration;
  const requestedFacingMode = facingMode;
  if (predictionInterval) clearInterval(predictionInterval);
  predictionInterval = null;
  if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
  webcamStream = null;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: requestedFacingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    webcamStream = stream;
    video.srcObject = webcamStream;
    await video.play();

    video.style.transform = requestedFacingMode === "user" ? "scaleX(-1)" : "none";
    el("cameraViewport").classList.add("live");
    el("cameraPlaceholder").hidden = true;
    el("liveBadge").hidden = false;
    el("permissionBanner").hidden = true;
    setStatus("cameraStatus", "online", "Active");
    log(`Camera started (${requestedFacingMode})`, "success");
    startPredictionLoop();
  } catch (error) {
    if (generation !== cameraGeneration) return;
    if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
    video.srcObject = null;
    el("cameraViewport").classList.remove("live");
    el("liveBadge").hidden = true;
    el("permissionBanner").hidden = false;
    setStatus("cameraStatus", "offline", "Denied");
    log(`Camera access denied: ${error.message}`, "error");
    toast("Allow camera access to start recognition", "warning");
  }
}

async function flipCamera() {
  if (!tmModel) {
    toast("Load a model before changing the camera", "warning");
    return;
  }
  facingMode = facingMode === "user" ? "environment" : "user";
  await startCamera();
}

function startPredictionLoop() {
  if (predictionInterval) clearInterval(predictionInterval);
  predictionInterval = setInterval(runPrediction, sendIntervalMs);
}

async function runPrediction() {
  if (inferenceBusy || !tmModel || !webcamStream || video.readyState < 2) return;
  inferenceBusy = true;
  const generation = cameraGeneration;
  try {
    const predictions = await tmModel.predict(video);
    if (generation !== cameraGeneration || !webcamStream) return;
    const top = predictions.reduce((best, item) =>
      item.probability > best.probability ? item : best
    );

    el("predValue").textContent = top.className;
    el("predConf").textContent = `${Math.round(top.probability * 100)}%`;
    renderPredictionBars(predictions);

    if (uartRxChar &&
        top.probability >= confidenceThreshold &&
        top.className !== lastPrediction) {
      const sent = await sendString(top.className);
      if (sent) lastPrediction = top.className;
    }
  } catch (error) {
    if (generation === cameraGeneration) log(`Inference error: ${error.message}`, "error");
  } finally {
    inferenceBusy = false;
  }
}

function renderProbabilityBars(labels) {
  const list = el("probabilityList");
  list.replaceChildren();
  labels.forEach((label) => {
    const row = document.createElement("div");
    row.className = "probability-row";
    row.dataset.label = label;
    const name = document.createElement("span");
    name.className = "probability-name";
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "probability-track";
    const fill = document.createElement("div");
    fill.className = "probability-fill";
    track.appendChild(fill);
    const value = document.createElement("span");
    value.className = "probability-value";
    value.textContent = "0%";
    row.append(name, track, value);
    list.appendChild(row);
  });
}

function renderPredictionBars(predictions) {
  predictions.forEach((prediction) => {
    const rows = el("probabilityList").querySelectorAll(".probability-row");
    rows.forEach((row) => {
      if (row.dataset.label === prediction.className) {
        const percent = Math.round(prediction.probability * 100);
        row.querySelector(".probability-fill").style.width = `${percent}%`;
        row.querySelector(".probability-value").textContent = `${percent}%`;
      }
    });
  });
}

function playFeedback() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 520;
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
  } catch {
    // Audio feedback is optional and may be blocked by the browser.
  }
}

function createNameRow(name) {
  const row = document.createElement("div");
  row.className = "name-row";
  const input = document.createElement("input");
  input.value = name;
  input.setAttribute("aria-label", "Command name");
  input.maxLength = 64;
  const send = document.createElement("button");
  send.type = "button";
  send.className = "send-name";
  send.textContent = "Send";
  send.addEventListener("click", () => sendString(input.value));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-name";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove command");
  remove.addEventListener("click", () => row.remove());
  row.append(input, send, remove);
  el("nameGrid").appendChild(row);
}

function stopEverything() {
  sessionGeneration++;
  cameraGeneration++;
  modelGeneration++;
  connecting = false;
  if (predictionInterval) clearInterval(predictionInterval);
  predictionInterval = null;
  if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
  webcamStream = null;

  if (bleDevice) {
    bleDevice.removeEventListener("gattserverdisconnected", onBleDisconnected);
  }
  if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  bleDevice = null;
  bleServer = null;
  uartRxChar = null;
  gattBusy = false;
  gattOperation++;
  tmModel = null;
  lastPrediction = null;

  video.srcObject = null;
  video.style.transform = "none";
  el("cameraViewport").classList.remove("live");
  el("cameraPlaceholder").hidden = false;
  el("liveBadge").hidden = true;
  el("permissionBanner").hidden = true;
  el("predValue").textContent = "Waiting";
  el("predConf").textContent = "—";
  el("probabilityList").replaceChildren();
  const empty = document.createElement("div");
  empty.className = "probability-empty";
  empty.textContent = "Load a model to view class probabilities";
  el("probabilityList").appendChild(empty);

  el("connectButton").classList.remove("connected");
  el("connectButton").querySelector(".connect-icon").textContent = "+";
  el("connectButton").querySelector(".connect-label").textContent = "Connect device";
  setStatus("bleStatus", "offline", "Offline");
  setStatus("mlStatus", "offline", "Idle");
  setStatus("cameraStatus", "offline", "Off");
  el("loadButton").querySelector(".load-label").textContent = "Load model";
  setLoading(el("loadButton"), false);
  log("Stopped camera, model and Bluetooth session", "warn");
  toast("Workspace stopped");
}

function init() {
  ["Sahil", "Tanwir", "Suhayl", "Wak", "Admin"].forEach(createNameRow);
  log("Visionè Eloise workspace ready");

  el("connectButton").addEventListener("click", handleConnect);
  el("disconnectButton").addEventListener("click", stopEverything);
  el("loadButton").addEventListener("click", loadModel);
  el("flipButton").addEventListener("click", flipCamera);
  el("retryCamera").addEventListener("click", startCamera);
  el("clearLog").addEventListener("click", () => el("activityLog").replaceChildren());
  el("addNameButton").addEventListener("click", () => createNameRow(""));
  document.querySelectorAll(".faq-item h3 button").forEach((button) => {
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      el(button.getAttribute("aria-controls")).hidden = expanded;
    });
  });

  el("intervalSlider").addEventListener("input", (event) => {
    sendIntervalMs = Number(event.target.value) * 1000;
    el("intervalOutput").textContent = `${Number(event.target.value).toFixed(1)}s`;
    if (predictionInterval) startPredictionLoop();
  });
  el("thresholdSlider").addEventListener("input", (event) => {
    confidenceThreshold = Number(event.target.value);
    el("thresholdOutput").textContent = `${Math.round(confidenceThreshold * 100)}%`;
  });

  if (!window.isSecureContext) {
    log("Secure context required: use HTTPS or localhost", "warn");
    toast("Open this app over HTTPS or localhost", "warning");
  }
  if (!navigator.bluetooth) {
    log("Bluetooth unavailable — Chrome or Edge required", "warn");
  }

  window.addEventListener("beforeunload", () => {
    if (predictionInterval) clearInterval(predictionInterval);
    if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
  });

  setTimeout(() => {
    el("splash").classList.add("hidden");
    document.querySelector(".app-shell").classList.add("ready");
  }, 450);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").then(
        () => log("Offline app shell registered", "success"),
        (error) => log(`Offline shell unavailable: ${error.message}`, "warn")
      );
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
