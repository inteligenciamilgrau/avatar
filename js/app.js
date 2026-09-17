import { VoxelAvatar } from "./avatar.js";
import { Avatar3D } from "./avatar3d.js";
import { Background } from "./bg.js";
import { TtsClient } from "./tts.js";
import { visemeAt, visemeFromOpen } from "./lipsync.js";
import { GptLiveSession } from "./live.js";
import { GeminiLiveSession } from "./gemini.js";
import { WhisperMic } from "./stt.js";

const $ = (id) => document.getElementById(id);
const PREFS_KEY = "avatarVoxel.prefs.v1";

const DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct-2507-q4_K_M";

const PRESETS = [
  "Quem é você?",
  "O que você faz?",
  "Está tudo bem?",
  "Me dê um conselho rápido.",
];

const state = {
  speaking: false,
  generating: false,
  visemes: [],
  words: [],
  text: "",
  startedAt: 0,
  durationMs: 0,
  mode: "sapi",
  view: "2d",
  llmEngine: "ollama",
  mouthGain: {},
  panelWidth: 400,
  chat: [],
  turnId: 0,
  abort: null,
  speakQueue: [],
  pumping: false,
};

const avatar = new VoxelAvatar($("avatar"));
const avatar3d = new Avatar3D($("avatar3d"));
const bg = new Background($("bg"));
const tts = new TtsClient();
const live = new GptLiveSession();
const gemini = new GeminiLiveSession();
const stt = new WhisperMic();
let loading3d = null;
let defaultSystem = "";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function persist() {
  const prefs = {
    text: $("text").value,
    voice: $("voice").value,
    speed: Number($("speed").value),
    volume: Number($("volume").value),
    engine: $("engineSapi").checked ? "sapi" : "browser",
    mouthMask: $("mouthMask").checked,
    view: state.view,
    llmEngine: $("llmEngine").value,
    liveVoice: $("liveVoice") ? $("liveVoice").value : "",
    geminiVoice: $("geminiVoice") ? $("geminiVoice").value : "Kore",
    whisperModel: $("whisperModel") ? $("whisperModel").value : "small",
    whisperLang: $("whisperLang") ? $("whisperLang").value : "pt",
    useOllama: $("useOllama").checked,
    autoStartOllama: $("autoStartOllama").checked,
    ollamaModel: $("ollamaModel").value,
    ollamaEndpoint: $("ollamaEndpoint").value,
    ollamaPort: Number($("ollamaPort").value),
    ollamaKey: $("ollamaKey").value,
    systemPrompt: $("systemPrompt").value,
    panelWidth: state.panelWidth,
    mouthGain: state.mouthGain || {},
    chat: state.chat.filter((m) => !m.pending).slice(-40),
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* quota / private mode */
  }
}

function applyStaticPrefs(p) {
  if (typeof p.text === "string") $("text").value = p.text;
  if (Number.isFinite(Number(p.speed))) {
    $("speed").value = String(p.speed);
    $("speedVal").textContent = Number(p.speed).toFixed(2) + "×";
  }
  if (Number.isFinite(Number(p.volume))) {
    $("volume").value = String(p.volume);
    $("volumeVal").textContent = Math.round(Number(p.volume)) + "%";
  }
  if (typeof p.mouthMask === "boolean") $("mouthMask").checked = p.mouthMask;
  if (p.llmEngine === "ollama" || p.llmEngine === "gpt-live-1" || p.llmEngine === "gemini-3.8-live") {
    $("llmEngine").value = p.llmEngine;
    state.llmEngine = p.llmEngine;
  }
  if (typeof p.liveVoice === "string" && p.liveVoice) $("liveVoice").value = p.liveVoice;
  if (typeof p.geminiVoice === "string" && p.geminiVoice) $("geminiVoice").value = p.geminiVoice;
  if (typeof p.whisperModel === "string" && $("whisperModel") && p.whisperModel) {
    $("whisperModel").value = p.whisperModel;
  }
  if (typeof p.whisperLang === "string" && $("whisperLang") && p.whisperLang) {
    $("whisperLang").value = p.whisperLang;
  }
  if (typeof p.useOllama === "boolean") $("useOllama").checked = p.useOllama;
  if (typeof p.autoStartOllama === "boolean") $("autoStartOllama").checked = p.autoStartOllama;
  if (typeof p.systemPrompt === "string" && p.systemPrompt.trim()) {
    $("systemPrompt").value = p.systemPrompt;
  }
  if (Number.isFinite(Number(p.panelWidth))) state.panelWidth = Number(p.panelWidth);
  if (p.mouthGain && typeof p.mouthGain === "object") state.mouthGain = p.mouthGain;
  if (typeof p.ollamaEndpoint === "string" && p.ollamaEndpoint.trim()) {
    $("ollamaEndpoint").value = p.ollamaEndpoint;
  }
  if (Number.isFinite(Number(p.ollamaPort)) && Number(p.ollamaPort) > 0) {
    $("ollamaPort").value = String(p.ollamaPort);
  }
  if (typeof p.ollamaKey === "string") $("ollamaKey").value = p.ollamaKey;
}

function ollamaConn() {
  return {
    endpoint: ($("ollamaEndpoint").value || "127.0.0.1").trim(),
    port: Number($("ollamaPort").value) || 11434,
    key: $("ollamaKey").value,
  };
}

function renderChat() {
  const log = $("chatLog");
  const msgs = state.chat.filter((m) => m.role === "user" || m.role === "assistant");
  if (!msgs.length) {
    log.innerHTML = '<p class="chat-empty">Nenhuma mensagem ainda.</p>';
    return;
  }
  log.innerHTML = "";
  for (const m of msgs) {
    const el = document.createElement("div");
    el.className = "bubble " + m.role + (m.pending ? " pending" : "");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = m.role === "user" ? "Você" : "Avatar";
    const body = document.createElement("div");
    body.textContent = m.content;
    el.appendChild(who);
    el.appendChild(body);
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}

const prefs = loadPrefs();
applyStaticPrefs(prefs);
if (Array.isArray(prefs.chat)) {
  state.chat = prefs.chat
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
}
renderChat();

function setStatus(label, kind) {
  const el = $("status");
  if (!el) return;
  const k = kind || "idle";
  el.dataset.kind = k;
  if (k === "idle") {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = label;
}

function setCaption(text, words, tMs) {
  const el = $("caption");
  if (!el) return;
  if (!text) {
    el.innerHTML = "";
    return;
  }
  if (!words || !words.length) {
    el.textContent = text;
    return;
  }
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].t <= tMs) active = i;
  }
  const parts = [];
  let cursor = 0;
  words.forEach((w, i) => {
    const start = Math.max(0, w.start | 0);
    const len = Math.max(1, w.len | 0);
    if (start > cursor) parts.push(escapeHtml(text.slice(cursor, start)));
    const piece = escapeHtml(text.slice(start, start + len));
    parts.push(i === active ? `<mark>${piece}</mark>` : piece);
    cursor = start + len;
  });
  if (cursor < text.length) parts.push(escapeHtml(text.slice(cursor)));
  el.innerHTML = parts.join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fillVoices(voices, preferred) {
  const sel = $("voice");
  sel.innerHTML = "";
  const groups = new Map();
  for (const v of voices) {
    const g = v.culture || "outros";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(v);
  }
  for (const [culture, list] of groups) {
    const og = document.createElement("optgroup");
    og.label = culture;
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.gender ? `${v.name} · ${v.gender}` : v.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  const want =
    preferred ||
    voices.find((v) => /maria/i.test(v.name))?.name ||
    voices.find((v) => (v.culture || "").toLowerCase().startsWith("pt"))?.name ||
    voices[0]?.name;
  if (want) sel.value = want;
}

function fillModels(models, preferred) {
  const sel = $("ollamaModel");
  sel.innerHTML = "";
  const list = models && models.length ? models.slice() : [DEFAULT_OLLAMA_MODEL];
  if (preferred && !list.includes(preferred)) list.unshift(preferred);
  if (!list.includes(DEFAULT_OLLAMA_MODEL)) list.unshift(DEFAULT_OLLAMA_MODEL);
  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value =
    (preferred && list.includes(preferred) && preferred) ||
    (list.includes(DEFAULT_OLLAMA_MODEL) && DEFAULT_OLLAMA_MODEL) ||
    list[0];
}

function isGptLive() {
  return $("llmEngine").value === "gpt-live-1";
}

function isGeminiLive() {
  return $("llmEngine").value === "gemini-3.8-live";
}

function isVoiceLive() {
  return isGptLive() || isGeminiLive();
}

function liveEngineLabel() {
  if (isGeminiLive()) return "Gemini 3.8 Live";
  if (isGptLive()) return "GPT-Live";
  return "Voz ao vivo";
}

function updateSendUi() {
  const engine = $("llmEngine").value;
  state.llmEngine = engine;
  const liveOn = isVoiceLive();
  const ollamaOn = engine === "ollama" && $("useOllama").checked;
  $("btnSpeak").textContent = liveOn ? "Enviar" : ollamaOn ? "Perguntar" : "Falar";
  $("sendHint").textContent = isGeminiLive()
    ? "Enter envia texto ao Gemini 3.8 Live · Conectar voz para falar ao microfone"
    : isGptLive()
      ? "Enter envia texto ao GPT-Live · Conectar voz para falar ao microfone"
      : ollamaOn
        ? "Enter envia texto · Conectar voz ou Mic para falar (Whisper + Ollama, 100% local)"
        : "Enter envia · Shift+Enter quebra a linha · fala o texto como está";
  const watch = $("ollamaWatch");
  if (watch) watch.hidden = !ollamaOn;
  const sttBar = $("sttBar");
  if (sttBar) sttBar.hidden = !ollamaOn;
  if ($("btnMic")) $("btnMic").hidden = !ollamaOn;
  const bar = $("liveBar");
  if (bar) bar.hidden = !liveOn;
  if ($("liveStatus") && !live.ready && !gemini.ready) {
    $("liveStatus").textContent = liveOn ? liveEngineLabel() + " desconectado" : "Voz ao vivo desconectada";
  }
}

function drawMeter(values) {
  const canvas = $("meter");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 280;
  const cssH = canvas.clientHeight || 48;
  if (canvas.width !== Math.floor(cssW * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = values.length;
  const gap = 2 * dpr;
  const bw = (w - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const v = values[i] || 0;
    const bh = Math.max(2 * dpr, v * h);
    const x = i * (bw + gap);
    const g = ctx.createLinearGradient(0, h - bh, 0, h);
    g.addColorStop(0, "#e8ff4a");
    g.addColorStop(1, "#1dff6a");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.35 + v * 0.65;
    ctx.fillRect(x, h - bh, bw, bh);
  }
  ctx.globalAlpha = 1;
}

function mouthKeySapi() {
  return "sapi:" + ($("voice").value || "default");
}

function mouthKeyLive() {
  return "live:" + ($("liveVoice").value || "bossa");
}

function mouthKeyGemini() {
  return "gemini:" + ($("geminiVoice").value || "Kore");
}

function currentMouthKey() {
  if (isGeminiLive()) return mouthKeyGemini();
  if (isGptLive()) return mouthKeyLive();
  return mouthKeySapi();
}

function parseMouthRange(v) {
  if (v && typeof v === "object") {
    let min = Number(v.min);
    let max = Number(v.max);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 1;
    min = Math.max(0, Math.min(0.9, min));
    max = Math.max(0.1, Math.min(1, max));
    if (max < min) max = min;
    return { min, max };
  }
  if (Number.isFinite(Number(v))) {
    const max = Math.max(0.15, Math.min(1, Number(v) > 1.5 ? 1 : Number(v)));
    return { min: 0, max };
  }
  return { min: 0, max: 1 };
}

function getMouthRange(key) {
  return parseMouthRange((state.mouthGain || {})[key]);
}

function setMouthRange(key, patch) {
  if (!state.mouthGain) state.mouthGain = {};
  const cur = getMouthRange(key);
  const next = parseMouthRange({ ...cur, ...patch });
  state.mouthGain[key] = next;
  persist();
  return next;
}

function currentMouthRange() {
  return getMouthRange(currentMouthKey());
}

function updateMouthGainUi() {
  const sg = getMouthRange(mouthKeySapi());
  if ($("mouthMin")) $("mouthMin").value = String(Math.round(sg.min * 100));
  if ($("mouthMax")) $("mouthMax").value = String(Math.round(sg.max * 100));
  if ($("mouthMinVal")) $("mouthMinVal").textContent = Math.round(sg.min * 100) + "%";
  if ($("mouthMaxVal")) $("mouthMaxVal").textContent = Math.round(sg.max * 100) + "%";
  if ($("mouthGainHint")) {
    $("mouthGainHint").textContent =
      "Windows · " + ($("voice").value || "voz atual") + " · min " + Math.round(sg.min * 100) + "% / max " + Math.round(sg.max * 100) + "%";
  }
  const lg = getMouthRange(mouthKeyLive());
  if ($("liveMouthMin")) $("liveMouthMin").value = String(Math.round(lg.min * 100));
  if ($("liveMouthMax")) $("liveMouthMax").value = String(Math.round(lg.max * 100));
  if ($("liveMouthMinVal")) $("liveMouthMinVal").textContent = Math.round(lg.min * 100) + "%";
  if ($("liveMouthMaxVal")) $("liveMouthMaxVal").textContent = Math.round(lg.max * 100) + "%";
  if ($("liveMouthGainHint")) {
    $("liveMouthGainHint").textContent =
      "OpenAI · " + ($("liveVoice").value || "bossa") + " · min " + Math.round(lg.min * 100) + "% / max " + Math.round(lg.max * 100) + "%";
  }
  const gg = getMouthRange(mouthKeyGemini());
  if ($("geminiMouthMin")) $("geminiMouthMin").value = String(Math.round(gg.min * 100));
  if ($("geminiMouthMax")) $("geminiMouthMax").value = String(Math.round(gg.max * 100));
  if ($("geminiMouthMinVal")) $("geminiMouthMinVal").textContent = Math.round(gg.min * 100) + "%";
  if ($("geminiMouthMaxVal")) $("geminiMouthMaxVal").textContent = Math.round(gg.max * 100) + "%";
  if ($("geminiMouthGainHint")) {
    $("geminiMouthGainHint").textContent =
      "Google · " + ($("geminiVoice").value || "Kore") + " · min " + Math.round(gg.min * 100) + "% / max " + Math.round(gg.max * 100) + "%";
  }
}

function scaledEnergy(raw) {
  const { min, max } = currentMouthRange();
  const e = Math.max(0, Math.min(1, Number(raw) * 3.2));
  return min + e * Math.max(0, max - min);
}

function currentTimeMs() {
  if (state.mode === "sapi" && tts.audio && !tts.audio.paused) {
    return tts.audio.currentTime * 1000;
  }
  if (state.speaking) return Math.max(0, performance.now() - state.startedAt);
  return 0;
}

function applyLipsync() {
  if (!state.speaking) {
    avatar.setEnergy(0);
    drawMeter(new Array(16).fill(0.05));
    return;
  }
  const t = currentTimeMs();
  const hit = visemeAt(state.visemes, t);
  const raw = state.mode === "sapi" ? tts.rms() : 0.35;
  const energy = scaledEnergy(raw);
  const name = visemeFromOpen(hit.name || "rest", energy);
  avatar.setViseme(name);
  avatar.setEnergy(energy);
  avatar.setSpeaking(true);
  avatar3d.setViseme(name);
  avatar3d.setSpeaking(true);
  if ($("visemeHud")) $("visemeHud").textContent = (hit.name || "rest").toUpperCase();
  setCaption(state.text, state.words, t);
  drawMeter(state.mode === "sapi" ? tts.bands() : pulseBands(energy));
}

function pulseBands(energy) {
  const t = performance.now() / 180;
  return Array.from({ length: 16 }, (_, i) => {
    const w = 0.35 + Math.sin(t + i * 0.45) * 0.25;
    return Math.max(0.08, energy * (0.5 + w));
  });
}

function pullSpeakable(buf, ended) {
  const chunks = [];
  let rest = buf;
  while (true) {
    const m = rest.match(/^([\s\S]*?[.!?…]+)(\s+|$)/);
    if (m && m[1].trim().length >= 1) {
      chunks.push(m[1].trim());
      rest = rest.slice(m[0].length);
      continue;
    }
    if (ended) {
      if (rest.trim()) chunks.push(rest.trim());
      rest = "";
      break;
    }
    if (rest.length >= 72) {
      const cut = Math.max(rest.lastIndexOf(", ", 72), rest.lastIndexOf(" ", 72));
      if (cut >= 20) {
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trimStart();
        continue;
      }
    }
    break;
  }
  return { chunks, rest };
}

function cleanChunk(s) {
  return String(s || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function interruptAndBegin() {
  state.turnId += 1;
  if (state.abort) {
    try {
      state.abort.abort();
    } catch (e) {}
  }
  state.abort = null;
  state.speakQueue = [];
  state.pumping = false;
  tts.stop();
  state.speaking = false;
  state.generating = true;
  avatar.setSpeaking(false);
  return state.turnId;
}

function enqueueSpeech(text, turn) {
  const t = cleanChunk(text);
  if (!t || turn !== state.turnId) return;
  state.speakQueue.push(t);
  pumpSpeech(turn);
}

async function pumpSpeech(turn) {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (turn === state.turnId && state.speakQueue.length) {
      const text = state.speakQueue.shift();
      await playChunk(text, turn);
    }
  } finally {
    if (turn === state.turnId) state.pumping = false;
  }
}

async function waitPumpIdle(turn) {
  while (turn === state.turnId && (state.speakQueue.length || state.pumping)) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function playChunk(text, turn) {
  if (turn !== state.turnId || !text) return;
  if (tts.mode === "sapi") await tts.unlock();
  if (turn !== state.turnId) return;
  const payload = {
    text,
    voice: $("voice").value,
    speed: Number($("speed").value),
    volume: Number($("volume").value),
  };
  let session;
  try {
    if (tts.mode === "sapi") session = await tts.speakSapi(payload);
    else {
      session = await tts.speakBrowser({
        text,
        voiceName: payload.voice,
        speed: payload.speed,
      });
    }
  } catch (e) {
    if (e.name === "AbortError" || turn !== state.turnId) return;
    throw e;
  }
  if (turn !== state.turnId) return;
  state.mode = session.mode;
  state.text = text;
  state.visemes = session.visemes || [];
  state.words = session.words || [];
  state.durationMs = session.durationMs || 0;
  state.speaking = true;
  state.startedAt = performance.now();
  setStatus("FALANDO", "talk");
  setCaption(text, state.words, 0);
  await tts.waitUntilDone(session);
}

async function streamOllama(text, turn, onUpdate) {
  const history = state.chat.filter((m) => !m.pending && (m.role === "user" || m.role === "assistant"));
  const forApi = history.slice(0, -1).slice(-16);
  const ac = new AbortController();
  state.abort = ac;
  const r = await fetch("/api/ollama/chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model: $("ollamaModel").value || DEFAULT_OLLAMA_MODEL,
      system: $("systemPrompt").value.trim(),
      history: forApi,
      ...ollamaConn(),
    }),
    signal: ac.signal,
  });
  if (!r.ok) {
    let err = "falha no Ollama";
    try {
      const j = await r.json();
      err = j.error || err;
    } catch (e) {}
    throw new Error(err);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  let full = "";
  while (true) {
    if (turn !== state.turnId) throw new DOMException("cancelado", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const piece = (j.message && j.message.content) || "";
      if (piece) {
        full += piece;
        onUpdate(full);
      }
    }
  }
  return full;
}

function liveAppend(role, delta) {
  if (!delta) return;
  if (role === "user" && Date.now() < (state.liveTypedUntil || 0)) return;
  const last = state.chat[state.chat.length - 1];
  if (last && last.role === role && last.live) {
    if (delta.startsWith(last.content) || last.content.startsWith(delta)) {
      if (delta.length >= last.content.length) last.content = delta;
    } else {
      last.content += delta;
    }
  } else {
    state.chat.push({ role, content: delta, live: true });
  }
  renderChat();
}

function setLiveUi(connected) {
  const bar = $("liveBar");
  if (bar) bar.classList.toggle("is-on", !!connected);
  if ($("btnLiveConnect")) $("btnLiveConnect").hidden = !!connected;
  if ($("btnLiveDisconnect")) $("btnLiveDisconnect").hidden = !connected;
}

function bindLiveEvents(session, startedLabel) {
  session.onStatus = (msg) => {
    if ($("liveStatus")) $("liveStatus").textContent = msg;
    setStatus(msg, "busy");
  };
  session.onEvent = (ev) => {
    if (ev.type === "session.started") {
      setLiveUi(true);
      setStatus(startedLabel, "talk");
    }
    if (ev.type === "session.input_transcript.delta") liveAppend("user", ev.delta);
    if (ev.type === "session.output_transcript.delta") liveAppend("assistant", ev.delta);
    if (ev.type === "session.closed") {
      setLiveUi(false);
      persist();
    }
  };
}

async function connectLive() {
  try {
    await gemini.disconnect();
  } catch (e) {}
  bindLiveEvents(live, "GPT-Live no ar");
  await live.connect({
    instructions: ($("systemPrompt").value || "").trim(),
    voice: $("liveVoice").value || "bossa",
    withMic: true,
  });
}

async function connectGemini() {
  try {
    await live.disconnect();
  } catch (e) {}
  bindLiveEvents(gemini, "Gemini 3.8 Live no ar");
  await gemini.connect({
    instructions: ($("systemPrompt").value || "").trim(),
    voice: $("geminiVoice").value || "Kore",
    model: "gemini-3.8-live",
    withMic: true,
  });
}

async function connectVoiceSession() {
  if (isGeminiLive()) return connectGemini();
  return connectLive();
}

async function disconnectVoiceSession() {
  try {
    await live.disconnect();
  } catch (e) {}
  try {
    await gemini.disconnect();
  } catch (e) {}
  setLiveUi(false);
}

async function sendLiveText(asked) {
  if (isGeminiLive()) {
    if (!gemini.ready) await connectGemini();
    state.liveTypedUntil = Date.now() + 10000;
    state.chat.push({ role: "user", content: asked });
    renderChat();
    persist();
    if (!gemini.sendText(asked)) throw new Error("Sessao Gemini nao esta pronta");
    return;
  }
  if (!live.ready) await connectLive();
  state.liveTypedUntil = Date.now() + 10000;
  state.chat.push({ role: "user", content: asked });
  renderChat();
  persist();
  if (!live.sendText(asked)) throw new Error("Sessao GPT-Live nao esta pronta");
}

function currentLiveSession() {
  if (isGeminiLive()) return gemini;
  if (isGptLive()) return live;
  return null;
}

function applyLiveLipsync() {
  const sess = currentLiveSession();
  if (!sess || !sess.ready) return;
  if (state.speaking) return;
  const energy = scaledEnergy(sess.rms());
  const talking = energy > 0.028;
  avatar.setSpeaking(talking);
  avatar3d.setSpeaking(talking);
  if (talking) {
    const name = visemeFromOpen("aa", energy);
    avatar.setViseme(name);
    avatar.setEnergy(energy);
    avatar3d.setViseme(name);
  }
}

function cleanSttText(s) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2) return "";
  if (/^[\s.,;:!?…\-–—'"“”]+$/.test(t)) return "";
  return t;
}

function setSttUi(connected, listening) {
  const bar = $("sttBar");
  if (bar) {
    bar.classList.toggle("is-on", !!connected);
    bar.classList.toggle("is-listen", !!listening);
  }
  if ($("btnSttConnect")) $("btnSttConnect").hidden = !!connected;
  if ($("btnSttDisconnect")) $("btnSttDisconnect").hidden = !connected;
}

function setSttStatus(msg, kind) {
  if ($("sttStatus")) $("sttStatus").textContent = msg;
  if (kind && kind !== "idle") setStatus(msg, kind === "listen" ? "busy" : kind);
}

async function ensureWhisperLoaded() {
  stt.language = ($("whisperLang") && $("whisperLang").value) || "pt";
  stt.model = ($("whisperModel") && $("whisperModel").value) || "small";
  setSttStatus("Carregando Faster Whisper…", "busy");
  const r = await fetch("/api/stt/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: stt.model, device: "auto" }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error((j && j.error) || "nao carregou o Faster Whisper");
  if ($("whisperHint")) {
    $("whisperHint").textContent =
      "Whisper " + (j.model || stt.model) + " · " + (j.device || "cpu") + (j.compute ? " · " + j.compute : "") + " · offline";
  }
  return j;
}

async function handleSttBlob(blob, { once } = {}) {
  setSttStatus("Transcrevendo…", "busy");
  const j = await stt.transcribe(blob, {
    language: ($("whisperLang") && $("whisperLang").value) || "pt",
    model: ($("whisperModel") && $("whisperModel").value) || "small",
  });
  const text = cleanSttText(j.text);
  if (!text) {
    setSttStatus(once ? "Nao entendi. Tente de novo." : "Ouvindo…", once ? "err" : "listen");
    return;
  }
  setSttStatus("Perguntando ao Ollama…", "busy");
  await speak(text);
}

async function connectStt({ once } = {}) {
  if (!isOllamaEngine()) throw new Error("Whisper so funciona no motor Ollama");
  await ensureWhisperLoaded();
  stt.onStatus = (msg, kind) => {
    setSttStatus(msg, kind);
    setSttUi(stt.connected, kind === "listen");
  };
  stt.onUtterance = async (blob) => {
    try {
      await handleSttBlob(blob, { once });
    } catch (e) {
      setSttStatus(e.message || "falha no Whisper", "err");
    } finally {
      if (once) {
        try {
          await stt.disconnect();
        } catch (e2) {}
        setSttUi(false, false);
      }
    }
  };
  await stt.connect();
  setSttUi(true, true);
}

function isOllamaEngine() {
  return $("llmEngine").value === "ollama" && $("useOllama").checked;
}

async function disconnectStt() {
  try {
    await stt.disconnect();
  } catch (e) {}
  setSttUi(false, false);
  if ($("sttStatus")) $("sttStatus").textContent = "Whisper desconectado";
}

async function speak(presetText) {
  const asked = String(presetText != null ? presetText : $("text").value).trim();
  if (!asked) return;
  if (isVoiceLive()) {
    if (presetText == null) $("text").value = "";
    persist();
    try {
      await sendLiveText(asked);
    } catch (e) {
      setStatus(e.message || "falha na voz ao vivo", "err");
    }
    $("text").focus();
    return;
  }
  const turn = interruptAndBegin();
  if (presetText == null) $("text").value = "";
  persist();
  state.chat.push({ role: "user", content: asked });
  const assistant = $("useOllama").checked ? { role: "assistant", content: "", pending: true } : null;
  if (assistant) state.chat.push(assistant);
  renderChat();
  $("text").focus();
  try {
    if (assistant) {
      setStatus("PENSANDO…", "busy");
      let queuedUpTo = 0;
      const flush = (ended) => {
        if (turn !== state.turnId) return;
        const pendingTxt = assistant.content.slice(queuedUpTo);
        const { chunks, rest } = pullSpeakable(pendingTxt, ended);
        for (const c of chunks) enqueueSpeech(c, turn);
        queuedUpTo = assistant.content.length - rest.length;
      };
      await streamOllama(asked, turn, (full) => {
        if (turn !== state.turnId) return;
        assistant.content = full;
        renderChat();
        flush(false);
        if (state.speaking || state.speakQueue.length) setStatus("FALANDO", "talk");
      });
      if (turn !== state.turnId) return;
      assistant.pending = false;
      renderChat();
      persist();
      flush(true);
    } else {
      enqueueSpeech(asked, turn);
    }
    await waitPumpIdle(turn);
    if (turn === state.turnId) finishTalk();
  } catch (err) {
    if (turn !== state.turnId || err.name === "AbortError") return;
    console.error(err);
    if (assistant && !assistant.content) {
      state.chat = state.chat.filter((m) => m !== assistant);
      renderChat();
      persist();
    } else if (assistant) {
      assistant.pending = false;
      renderChat();
      persist();
    }
    setStatus(err.message || "erro", "err");
    finishTalk();
  } finally {
    if (turn === state.turnId) {
      state.generating = false;
      $("text").focus();
    }
  }
}

function finishTalk() {
  state.speaking = false;
  avatar.setSpeaking(false);
  avatar.setViseme("rest");
  avatar.setEnergy(0);
  avatar3d.setSpeaking(false);
  avatar3d.setViseme("rest");
  if ($("visemeHud")) $("visemeHud").textContent = "REST";
  if ($("status") && $("status").dataset.kind !== "err") setStatus("PRONTA", "idle");
}

function stopTalk() {
  state.turnId += 1;
  if (state.abort) {
    try {
      state.abort.abort();
    } catch (e) {}
  }
  state.abort = null;
  state.speakQueue = [];
  state.pumping = false;
  tts.stop();
  state.generating = false;
  if (gemini.ready) gemini.flushAudio();
  finishTalk();
}

function previewViseme(name) {
  stopTalk();
  avatar.setViseme(name);
  avatar3d.setViseme(name);
  if ($("visemeHud")) $("visemeHud").textContent = name.toUpperCase();
  setStatus("PREVIEW · " + name.toUpperCase(), "busy");
}

function ensure3d() {
  if (loading3d) return loading3d;
  loading3d = avatar3d
    .load()
    .then(() => {
      avatar3d.start();
      if (state.view === "3d") avatar3d.setActive(true);
    })
    .catch((e) => {
      console.warn("3D Blender nao carregou", e);
      loading3d = null;
      throw e;
    });
  return loading3d;
}

function setView(view) {
  state.view = view === "3d" ? "3d" : "2d";
  const is3d = state.view === "3d";
  $("stage2d").hidden = is3d;
  $("stage3d").hidden = !is3d;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const on = btn.dataset.view === state.view;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  avatar3d.setActive(is3d);
  persist();
  if (is3d) {
    const hint0 = document.querySelector(".orbit-hint");
    if (hint0) hint0.textContent = "carregando modelo do blender…";
    ensure3d()
      .then(() => {
        const hint = document.querySelector(".orbit-hint");
        if (hint) hint.textContent = "arraste para orbitar · scroll para zoom";
        avatar3d.setActive(true);
        avatar3d.resize();
      })
      .catch(() => {
        const hint = document.querySelector(".orbit-hint");
        if (hint) hint.textContent = "falha ao importar o glb do blender";
      });
  }
}

async function boot() {
  bg.start();
  setStatus("CARREGANDO…", "busy");
  await avatar.load();
  avatar.setMouthMask($("mouthMask").checked);
  avatar.start();
  avatar.onFrame = () => {
    applyLipsync();
    applyLiveLipsync();
  };
  window.addEventListener("resize", () => {
    avatar.resize();
    avatar3d.resize();
  });
  ensure3d().catch(() => {});

  const sapi = await tts.probe();
  const wantSapi = prefs.engine === "browser" ? false : sapi;
  $("engineSapi").checked = wantSapi;
  $("engineBrowser").checked = !wantSapi;
  tts.mode = wantSapi ? "sapi" : "browser";
  $("engineHint").textContent = wantSapi
    ? "SAPI local · visemas reais do Windows"
    : sapi
      ? "Vozes do navegador (Web Speech API)"
      : "Navegador · abra com start.bat para usar as vozes do Windows";

  if (wantSapi) {
    try {
      fillVoices(await tts.loadSapiVoices(), prefs.voice);
    } catch (e) {
      console.warn(e);
      tts.mode = "browser";
      $("engineBrowser").checked = true;
      $("engineSapi").checked = false;
      fillVoices(await tts.loadBrowserVoices(), prefs.voice);
    }
  } else {
    fillVoices(await tts.loadBrowserVoices(), prefs.voice);
  }

  await refreshOllamaModels(prefs.ollamaModel);
  updateSendUi();
  updateMouthGainUi();
  if (state.llmEngine === "ollama") startOllamaWatch();
  try {
    const r = await fetch("/api/live/status");
    const j = await r.json();
    if ($("liveKeyHint")) {
      $("liveKeyHint").textContent = j.hasKey
        ? "Chave OpenAI encontrada no .env · modelo gpt-live-1"
        : "Coloque OPENAI_API_KEY no arquivo .env para usar GPT-Live-1";
    }
  } catch (e) {
    if ($("liveKeyHint")) $("liveKeyHint").textContent = "Nao foi possivel checar a chave OpenAI";
  }
  try {
    const r = await fetch("/api/gemini/status");
    const j = await r.json();
    if ($("geminiKeyHint")) {
      $("geminiKeyHint").textContent = j.hasKey
        ? "Chave Gemini encontrada no .env · modelo gemini-3.8-live"
        : "Coloque GEMINI_API_KEY no arquivo .env para usar Gemini 3.8 Live";
    }
  } catch (e) {
    if ($("geminiKeyHint")) $("geminiKeyHint").textContent = "Nao foi possivel checar a chave Gemini";
  }
  try {
    const r = await fetch("/api/stt/status");
    const j = await r.json();
    if ($("whisperHint")) {
      $("whisperHint").textContent = j.pythonOk
        ? j.ready
          ? "Whisper " + (j.model || "small") + " · " + (j.device || "") + " · pronto"
          : "Faster Whisper offline · Conectar voz carrega o modelo (small recomendado)"
        : "Python nao encontrado · crie o .venv e instale o requirements.txt";
    }
  } catch (e) {
    if ($("whisperHint")) $("whisperHint").textContent = "Nao foi possivel checar o Faster Whisper";
  }

  try {
    const r = await fetch("/api/ollama/system");
    const j = await r.json();
    defaultSystem = j.default || "";
    if (!$("systemPrompt").value.trim()) {
      $("systemPrompt").value = j.current || defaultSystem;
    }
  } catch (e) {
    if (!$("systemPrompt").value.trim() && defaultSystem) $("systemPrompt").value = defaultSystem;
  }

  $("loading").classList.add("hidden");
  $("loading").setAttribute("aria-hidden", "true");
  setStatus("PRONTA", "idle");
  if (prefs.view === "3d") setView("3d");
}

$("btnSpeak").addEventListener("click", speak);
$("btnStop").addEventListener("click", stopTalk);
$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    speak();
  }
});
$("btnClearChat").addEventListener("click", () => {
  state.chat = [];
  renderChat();
  persist();
});

$("text").addEventListener("input", persist);
$("voice").addEventListener("change", () => {
  updateMouthGainUi();
  persist();
});
function bindMouthRange(minId, maxId, keyFn) {
  const read = () => ({
    min: Number($(minId).value) / 100,
    max: Number($(maxId).value) / 100,
  });
  $(minId).addEventListener("input", () => {
    let { min, max } = read();
    if (min > max) max = min;
    setMouthRange(keyFn(), { min, max });
    updateMouthGainUi();
  });
  $(maxId).addEventListener("input", () => {
    let { min, max } = read();
    if (max < min) min = max;
    setMouthRange(keyFn(), { min, max });
    updateMouthGainUi();
  });
}
bindMouthRange("mouthMin", "mouthMax", mouthKeySapi);
bindMouthRange("liveMouthMin", "liveMouthMax", mouthKeyLive);
bindMouthRange("geminiMouthMin", "geminiMouthMax", mouthKeyGemini);
$("speed").addEventListener("input", () => {
  $("speedVal").textContent = Number($("speed").value).toFixed(2) + "×";
  persist();
});
$("volume").addEventListener("input", () => {
  $("volumeVal").textContent = $("volume").value + "%";
  persist();
});

$("engineSapi").addEventListener("change", async () => {
  tts.mode = "sapi";
  $("engineHint").textContent = "SAPI local · visemas reais do Windows";
  try {
    fillVoices(await tts.loadSapiVoices(), loadPrefs().voice);
    updateMouthGainUi();
    persist();
  } catch (e) {
    setStatus(e.message, "err");
  }
});
$("engineBrowser").addEventListener("change", async () => {
  tts.mode = "browser";
  $("engineHint").textContent = "Vozes do navegador (Web Speech API)";
  fillVoices(await tts.loadBrowserVoices(), loadPrefs().voice);
  updateMouthGainUi();
  persist();
});

const presets = $("presets");
PRESETS.forEach((p) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = p;
  b.addEventListener("click", () => {
    $("text").value = p;
    persist();
  });
  presets.appendChild(b);
});

$("mouthMask").addEventListener("change", () => {
  avatar.setMouthMask($("mouthMask").checked);
  persist();
});
$("llmEngine").addEventListener("change", async () => {
  updateSendUi();
  updateMouthGainUi();
  persist();
  await disconnectVoiceSession();
  await disconnectStt();
  if ($("llmEngine").value === "ollama") {
    startOllamaWatch();
    watchOllamaTick();
  } else if ($("ollamaWatch")) {
    $("ollamaWatch").hidden = true;
  }
});
$("whisperModel").addEventListener("change", persist);
$("whisperLang").addEventListener("change", persist);
$("btnSttConnect").addEventListener("click", async () => {
  try {
    await connectStt({ once: false });
  } catch (e) {
    setSttUi(false, false);
    setSttStatus(e.message || "falha ao conectar Whisper", "err");
  }
});
$("btnSttDisconnect").addEventListener("click", async () => {
  await disconnectStt();
});
$("btnMic").addEventListener("click", async () => {
  if (stt.connected) return;
  try {
    await connectStt({ once: true });
  } catch (e) {
    setSttUi(false, false);
    setSttStatus(e.message || "falha no microfone", "err");
  }
});
$("liveVoice").addEventListener("change", () => {
  updateMouthGainUi();
  persist();
});
$("geminiVoice").addEventListener("change", () => {
  updateMouthGainUi();
  persist();
});
$("useOllama").addEventListener("change", () => {
  updateSendUi();
  persist();
  if ($("useOllama").checked && $("llmEngine").value === "ollama") watchOllamaTick();
});
$("btnLiveConnect").addEventListener("click", async () => {
  try {
    await connectVoiceSession();
  } catch (e) {
    setLiveUi(false);
    if ($("liveStatus")) $("liveStatus").textContent = e.message || "falha ao conectar";
    setStatus(e.message || "falha na voz ao vivo", "err");
  }
});
$("btnLiveDisconnect").addEventListener("click", async () => {
  await disconnectVoiceSession();
  if ($("liveStatus")) $("liveStatus").textContent = liveEngineLabel() + " desconectado";
  avatar.setSpeaking(false);
  avatar3d.setSpeaking(false);
});
$("autoStartOllama").addEventListener("change", persist);
$("btnStartOllama").addEventListener("click", () => {
  ollamaAutoStartTried = true;
  startOllamaApp();
});
$("btnStopOllama").addEventListener("click", () => stopOllamaApp());
$("btnStopOllamaCfg").addEventListener("click", () => stopOllamaApp());
$("ollamaModel").addEventListener("change", persist);
$("ollamaEndpoint").addEventListener("change", persist);
$("ollamaPort").addEventListener("change", persist);
$("ollamaKey").addEventListener("change", persist);

let ollamaOnline = null;
let ollamaWatchTimer = 0;
let ollamaAutoStartTried = false;

function setOllamaWatch(online, extra) {
  const box = $("ollamaWatch");
  const text = $("ollamaWatchText");
  const btn = $("btnStartOllama");
  const stop = $("btnStopOllama");
  if (!box || !text) return;
  if (!$("useOllama").checked) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.remove("is-up", "is-down", "is-wait");
  if (online === "wait") {
    box.classList.add("is-wait");
    text.textContent = extra || "Abrindo o Ollama…";
    if (btn) btn.hidden = true;
    if (stop) stop.hidden = true;
    return;
  }
  if (online) {
    box.classList.add("is-up");
    text.textContent = extra || "Ollama no ar";
    if (btn) btn.hidden = true;
    if (stop) stop.hidden = false;
  } else {
    box.classList.add("is-down");
    text.textContent = extra || "Ollama desligado — falta subir o app";
    if (btn) btn.hidden = false;
    if (stop) stop.hidden = true;
  }
}

async function pingOllama() {
  const r = await fetch("/api/ollama/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaConn()),
  });
  return r.json();
}

async function watchOllamaTick() {
  if ($("llmEngine").value !== "ollama" || !$("useOllama").checked) {
    if ($("ollamaWatch")) $("ollamaWatch").hidden = true;
    return;
  }
  try {
    const j = await pingOllama();
    const up = !!j.ok;
    if (up !== ollamaOnline) {
      if (up) {
        setOllamaWatch(true, "Ollama no ar · " + ((j.models && j.models.length) || 0) + " modelo(s)");
        await refreshOllamaModels($("ollamaModel").value);
      } else {
        setOllamaWatch(false, j.error || "Ollama desligado — falta subir o app");
        if (!ollamaAutoStartTried && $("autoStartOllama").checked) {
          ollamaAutoStartTried = true;
          startOllamaApp();
        }
      }
      ollamaOnline = up;
    }
  } catch (e) {
    if (ollamaOnline !== false) {
      setOllamaWatch(false, "Ollama desligado — falta subir o app");
      ollamaOnline = false;
      if (!ollamaAutoStartTried && $("autoStartOllama").checked) {
        ollamaAutoStartTried = true;
        startOllamaApp();
      }
    }
  }
}

function startOllamaWatch() {
  if (ollamaWatchTimer) return;
  watchOllamaTick();
  ollamaWatchTimer = setInterval(watchOllamaTick, 2500);
}

async function stopOllamaApp() {
  setOllamaWatch("wait", "Parando o Ollama…");
  try {
    const r = await fetch("/api/ollama/stop", { method: "POST" });
    const j = await r.json();
    if (!j.ok) {
      setOllamaWatch(ollamaOnline ? true : false, j.error || "nao consegui parar");
      return;
    }
    ollamaOnline = false;
    setOllamaWatch(false, "Ollama parado");
  } catch (e) {
    setOllamaWatch(false, e.message || "nao consegui parar o Ollama");
  }
}

async function startOllamaApp() {
  setOllamaWatch("wait", "Abrindo o Ollama…");
  try {
    const r = await fetch("/api/ollama/start", { method: "POST" });
    const j = await r.json();
    if (j.already) {
      setOllamaWatch(true, "Ollama no ar");
      ollamaOnline = true;
      return;
    }
    if (!j.ok) {
      setOllamaWatch(false, j.error || "Nao consegui abrir o Ollama");
      return;
    }
    setOllamaWatch("wait", "Ollama abrindo — esperando ficar no ar…");
  } catch (e) {
    setOllamaWatch(false, "Nao consegui abrir o Ollama. Suba o app na bandeja.");
  }
}

async function refreshOllamaModels(preferred) {
  try {
    const r = await fetch("/api/ollama/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaConn()),
    });
    const j = await r.json();
    fillModels(j.models || [], preferred || $("ollamaModel").value || j.defaultModel || DEFAULT_OLLAMA_MODEL);
    $("ollamaHint").textContent = j.ok
      ? "Conectado em " + (j.url || "Ollama") + " · " + (j.models || []).length + " modelo(s)"
      : j.error || "Ollama offline";
    return j.ok;
  } catch (e) {
    fillModels([DEFAULT_OLLAMA_MODEL], preferred);
    $("ollamaHint").textContent = "Ollama offline · confira endpoint e porta";
    return false;
  }
}

$("btnTestOllama").addEventListener("click", async () => {
  $("ollamaHint").textContent = "testando…";
  persist();
  await refreshOllamaModels();
});
$("btnSaveOllama").addEventListener("click", async () => {
  persist();
  try {
    const r = await fetch("/api/ollama/conn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaConn()),
    });
    const j = await r.json();
    $("ollamaHint").textContent = j.ok
      ? "Conexão salva · " + j.endpoint + ":" + j.port
      : j.error || "nao salvou";
    await refreshOllamaModels();
  } catch (e) {
    $("ollamaHint").textContent = e.message || "falha ao salvar conexão";
  }
});
$("systemPrompt").addEventListener("input", persist);
$("btnSaveSystem").addEventListener("click", async () => {
  persist();
  try {
    const r = await fetch("/api/ollama/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: $("systemPrompt").value.trim() }),
    });
    const j = await r.json();
    $("systemHint").textContent = j.ok ? "System salvo neste site." : j.error || "nao salvou";
  } catch (e) {
    $("systemHint").textContent = e.message || "falha ao salvar";
  }
});
$("btnResetSystem").addEventListener("click", async () => {
  $("systemPrompt").value = defaultSystem;
  persist();
  try {
    await fetch("/api/ollama/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "" }),
    });
    $("systemHint").textContent = "Voltou ao system padrão.";
  } catch (e) {
    $("systemHint").textContent = "Restaurado nesta sessão.";
  }
});

document.querySelectorAll("[data-viseme]").forEach((btn) => {
  btn.addEventListener("click", () => previewViseme(btn.dataset.viseme));
});

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});
window.setAvatarView = setView;

function openConfig() {
  $("configModal").hidden = false;
  avatar.resize();
}
function closeConfig() {
  $("configModal").hidden = true;
}
$("btnConfig").addEventListener("click", openConfig);
$("btnCloseConfig").addEventListener("click", closeConfig);
$("configModal").addEventListener("click", (e) => {
  if (e.target === $("configModal")) closeConfig();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("configModal").hidden) closeConfig();
});

function setPanelWidth(px) {
  const min = 280;
  const max = Math.max(min, Math.min(780, window.innerWidth - 300));
  const w = Math.round(Math.max(min, Math.min(max, px)));
  state.panelWidth = w;
  $("appLayout").style.setProperty("--panel-w", w + "px");
  avatar.resize();
  avatar3d.resize();
  return w;
}

setPanelWidth(state.panelWidth || 400);

(function bindSplitter() {
  const split = $("splitter");
  if (!split) return;
  let dragging = false;
  split.addEventListener("pointerdown", (e) => {
    if (window.matchMedia("(max-width: 960px)").matches) return;
    dragging = true;
    split.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  split.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const app = $("appLayout").getBoundingClientRect();
    setPanelWidth(app.right - e.clientX);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    persist();
  };
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
  split.addEventListener("dblclick", () => {
    setPanelWidth(400);
    persist();
  });
})();

boot().catch((err) => {
  console.error(err);
  $("loading").classList.add("hidden");
  setStatus(err.message || "falha ao iniciar", "err");
});
