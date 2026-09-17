const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = __dirname;

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] == null) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT) || 8787;
const TTS_EXE = path.join(ROOT, "tools", "TtsTool.exe");
const TMP = path.join(ROOT, "tmp");
const DEFAULT_OLLAMA = {
  endpoint: "127.0.0.1",
  port: 11434,
  protocol: "http",
};
const DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct-2507-q4_K_M";
const OLLAMA_CONN_FILE = path.join(ROOT, "data", "ollama.json");
const OLLAMA_SYSTEM =
  "Você é um avatar voxel simpático. Responda em português do Brasil, de forma breve e natural, com frases completas — não fale telegráfico nem estilo Tarzan. Duas a quatro frases curtas bastam. Seja direto, sem enrolação, sem markdown, sem listas e sem emojis.";
const SYSTEM_FILE = path.join(ROOT, "data", "system.json");

function loadSavedSystem() {
  try {
    const j = JSON.parse(fs.readFileSync(SYSTEM_FILE, "utf8"));
    const s = String((j && j.system) || "").trim();
    return s ? s.slice(0, 8000) : "";
  } catch (e) {
    return "";
  }
}

function resolveSystem(body) {
  const fromClient = String((body && body.system) || "").trim().slice(0, 8000);
  return fromClient || loadSavedSystem() || OLLAMA_SYSTEM;
}

function loadSavedOllama() {
  try {
    return JSON.parse(fs.readFileSync(OLLAMA_CONN_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function resolveOllama(input) {
  const saved = loadSavedOllama();
  const src = input && typeof input === "object" ? input : {};
  let protocol = "http";
  let host = String(src.endpoint || saved.endpoint || DEFAULT_OLLAMA.endpoint).trim() || DEFAULT_OLLAMA.endpoint;
  let port = Number(src.port);
  if (/^https?:\/\//i.test(host)) {
    try {
      const u = new URL(host);
      protocol = u.protocol === "https:" ? "https" : "http";
      host = u.hostname;
      if (u.port) port = Number(u.port);
    } catch (e) {}
  }
  host = host.replace(/[^a-zA-Z0-9._:-]/g, "");
  if (!host) host = DEFAULT_OLLAMA.endpoint;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    port = Number(saved.port) || DEFAULT_OLLAMA.port;
  }
  const key =
    src.key != null && String(src.key).length
      ? String(src.key).slice(0, 500)
      : String(saved.key || process.env.OLLAMA_API_KEY || "");
  return {
    protocol,
    host,
    port,
    key,
    url: protocol + "://" + host + ":" + port,
  };
}

function findOllamaApp() {
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(local, "Programs", "Ollama", "ollama app.exe"),
    path.join(local, "Programs", "Ollama", "ollama.exe"),
    "C:\\Program Files\\Ollama\\ollama app.exe",
    "C:\\Program Files\\Ollama\\ollama.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "ollama";
}

function ollamaHeaders(conn) {
  const headers = { "Content-Type": "application/json" };
  if (conn.key) {
    headers.Authorization = "Bearer " + conn.key;
  }
  return headers;
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ico": "image/x-icon",
};

fs.mkdirSync(TMP, { recursive: true });

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function runTts(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(TTS_EXE)) {
      reject(new Error("TtsTool.exe nao encontrado. Rode start.bat para compilar."));
      return;
    }
    const child = spawn(TTS_EXE, args, {
      windowsHide: true,
      cwd: ROOT,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("TTS estourou o tempo limite"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim() || err.trim();
      try {
        const json = JSON.parse(text);
        if (json.ok === false) {
          reject(new Error(json.error || "falha no TTS"));
          return;
        }
        resolve(json);
      } catch (e) {
        reject(new Error(text || err || "TTS retornou saida invalida (code " + code + ")"));
      }
    });
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload grande demais"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Avatares. Cada pasta em assets/avatars/ vira um avatar. O formato e deduzido
// do conteudo: visemes/ com as fotos habilita o 2D, um .glb habilita o 3D, e
// ter os dois habilita as duas abas. O avatar.json e opcional e so ajusta.
// ---------------------------------------------------------------------------
const AVATARS_DIR = path.join(ROOT, "assets", "avatars");
const DEFAULT_AVATAR = "base";
// rest e o unico obrigatorio: e o rosto parado. Os outros entram se existirem.
const VISEME_NAMES = ["rest", "mbp", "s", "e", "aa", "aa_max", "o", "u"];
const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp"];

function findViseme(dir, name) {
  for (const ext of IMG_EXT) {
    if (fs.existsSync(path.join(dir, name + ext))) return name + ext;
  }
  return null;
}

function readAvatarManifest(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "avatar.json"), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

function scanAvatar(id) {
  const dir = path.join(AVATARS_DIR, id);
  if (!fs.statSync(dir).isDirectory()) return null;
  const manifest = readAvatarManifest(dir);
  const base = "assets/avatars/" + encodeURIComponent(id) + "/";

  const visemeDir = path.join(dir, "visemes");
  const visemes = {};
  if (fs.existsSync(visemeDir)) {
    for (const name of VISEME_NAMES) {
      const file = findViseme(visemeDir, name);
      if (file) visemes[name] = base + "visemes/" + file;
    }
  }
  const blinkFile = fs.existsSync(visemeDir) ? findViseme(visemeDir, "blink") : null;

  // model.glb tem preferencia; fora isso vale qualquer .glb solto na pasta.
  let model = null;
  const glbs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".glb"));
  if (glbs.length) {
    const preferred = glbs.find((f) => f.toLowerCase() === "model.glb") || glbs.sort()[0];
    model = base + encodeURIComponent(preferred);
  }

  const has2d = !!visemes.rest;
  const has3d = !!model;
  if (!has2d && !has3d) return null;

  return {
    id,
    name: String(manifest.name || id),
    description: String(manifest.description || ""),
    order: Number.isFinite(manifest.order) ? Number(manifest.order) : 500,
    has2d,
    has3d,
    visemes,
    blink: blinkFile ? base + "visemes/" + blinkFile : null,
    model,
    eyes: Array.isArray(manifest.eyes) ? manifest.eyes : null,
    glow: manifest.glow && typeof manifest.glow === "object" ? manifest.glow : null,
    jaw: manifest.jaw && typeof manifest.jaw === "object" ? manifest.jaw : null,
    morphs: manifest.morphs && typeof manifest.morphs === "object" ? manifest.morphs : null,
  };
}

function scanAvatars() {
  if (!fs.existsSync(AVATARS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(AVATARS_DIR)) {
    if (entry.startsWith(".")) continue;
    try {
      const a = scanAvatar(entry);
      if (a) out.push(a);
    } catch (e) {
      // Uma pasta quebrada nao pode derrubar a lista inteira.
      console.warn("avatar ignorado:", entry, e.message);
    }
  }
  // O padrao primeiro, depois o campo order, depois alfabetico.
  out.sort((a, b) => {
    if (a.id === DEFAULT_AVATAR) return -1;
    if (b.id === DEFAULT_AVATAR) return 1;
    return a.order - b.order || a.name.localeCompare(b.name);
  });
  return out;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostOf(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  const noPort = v.startsWith("[") ? v.slice(0, v.indexOf("]") + 1) : v.split(":")[0];
  return noPort;
}

// O servidor so escuta em 127.0.0.1, mas isso nao basta: um site qualquer pode mandar o
// navegador falar com esta porta (CSRF / DNS rebinding). Host e Origin tem que ser locais.
function isLocalRequest(req) {
  const host = hostOf(req.headers && req.headers.host);
  if (host && !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers && req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = hostOf(new URL(origin).host);
    } catch (e) {
      return false;
    }
    if (!LOCAL_HOSTS.has(originHost)) return false;
  }
  return true;
}

// Nunca servir segredos pela web: .env, .git, a chave salva do Ollama.
const PRIVATE_PATHS = [".env", ".git", "data", "node_modules", "blender", "package-lock.json"];

function isPrivatePath(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.startsWith("."))) return true;
  const first = (parts[0] || "").toLowerCase();
  return PRIVATE_PATHS.includes(first);
}

function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  } catch (e) {
    return null;
  }
  const rel = decoded.replace(/^[\\/]+/, "");
  if (isPrivatePath(rel)) return null;
  const full = path.normalize(path.join(base, rel || "index.html"));
  // base + separador: sem isso, uma pasta irma com nome parecido passaria no teste.
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function serveStatic(req, res) {
  let file = safeJoin(ROOT, req.url);
  if (!file) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (e2, data) => {
      if (e2) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("nao encontrado");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-cache" : "public, max-age=86400",
      });
      res.end(data);
    });
  });
}

function ollamaFetch(conn, pathname, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 120000);
  const signal = (opts && opts.signal) || ctrl.signal;
  return fetch(conn.url + pathname, {
    method: (opts && opts.method) || "GET",
    headers: ollamaHeaders(conn),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    signal,
  }).finally(() => clearTimeout(timer));
}

function cleanReply(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupTmp() {
  const now = Date.now();
  fs.readdir(TMP, (err, files) => {
    if (err) return;
    for (const f of files) {
      if (!/\.(wav|txt|webm|ogg)$/i.test(f)) continue;
      const p = path.join(TMP, f);
      fs.stat(p, (e2, st) => {
        if (!e2 && now - st.mtimeMs > 10 * 60 * 1000) fs.unlink(p, () => {});
      });
    }
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("audio grande demais"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const WHISPER_WORKER = path.join(ROOT, "tools", "whisper_worker.py");
const WHISPER_MODELS = new Set([
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v2",
  "large-v3",
  "large-v3-turbo",
  "turbo",
  "distil-large-v3",
  "distil-small.en",
]);
// Opcional: so serve para o Whisper achar o ffmpeg quando ele nao esta no PATH.
const FFMPEG_DIR = (process.env.FFMPEG_DIR || "").trim();

function findPython() {
  // O venv do projeto primeiro; depois o que o .env apontar; depois instalacoes comuns.
  const cands = [
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, ".venv", "bin", "python"),
    (process.env.WHISPER_PYTHON || "").trim(),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
  ].filter(Boolean);
  for (const p of cands) {
    if (fs.existsSync(p)) return p;
  }
  return "python";
}

let whisperChild = null;
let whisperBuf = "";
let whisperErr = "";
let whisperSeq = 0;
let whisperQueue = Promise.resolve();
const whisperWaiters = new Map();
let whisperInfo = { ready: false, model: null, device: null, compute: null, error: null };

function failWhisperWaiters(err) {
  for (const [id, w] of whisperWaiters) {
    clearTimeout(w.timer);
    w.reject(err);
    whisperWaiters.delete(id);
  }
}

function handleWhisperLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (msg.event === "hello") return;
  const id = msg.id;
  if (id && whisperWaiters.has(id)) {
    const w = whisperWaiters.get(id);
    whisperWaiters.delete(id);
    clearTimeout(w.timer);
    if (msg.ok === false) w.reject(new Error(msg.error || "falha no Faster Whisper"));
    else w.resolve(msg);
  }
}

function startWhisperProcess() {
  if (whisperChild && whisperChild.exitCode == null) return;
  const py = findPython();
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    HF_HUB_DISABLE_SYMLINKS: "1",
    TOKENIZERS_PARALLELISM: "false",
  });
  if (fs.existsSync(FFMPEG_DIR)) {
    env.PATH = FFMPEG_DIR + path.delimiter + (env.PATH || "");
  }
  whisperBuf = "";
  whisperErr = "";
  whisperChild = spawn(py, ["-u", WHISPER_WORKER], {
    windowsHide: true,
    cwd: ROOT,
    env,
  });
  whisperChild.stdout.on("data", (d) => {
    whisperBuf += d.toString("utf8");
    const lines = whisperBuf.split(/\r?\n/);
    whisperBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) handleWhisperLine(line);
    }
  });
  whisperChild.stderr.on("data", (d) => {
    whisperErr = (whisperErr + d.toString("utf8")).slice(-2500);
  });
  whisperChild.on("error", (e) => {
    whisperInfo.error = e.message;
    failWhisperWaiters(e);
  });
  whisperChild.on("close", (code) => {
    const err = new Error(
      (whisperErr && whisperErr.trim().split(/\r?\n/).slice(-4).join(" | ")) ||
        "Faster Whisper encerrou (" + code + ")"
    );
    whisperChild = null;
    whisperInfo.ready = false;
    failWhisperWaiters(err);
  });
}

function whisperSend(msg, timeoutMs) {
  startWhisperProcess();
  if (!whisperChild || !whisperChild.stdin.writable) {
    return Promise.reject(
      new Error("Faster Whisper nao iniciou. Crie o .venv e rode: pip install -r requirements.txt")
    );
  }
  return new Promise((resolve, reject) => {
    const id = "w" + ++whisperSeq;
    const timer = setTimeout(() => {
      whisperWaiters.delete(id);
      reject(new Error("Whisper estourou o tempo"));
    }, timeoutMs || 120000);
    whisperWaiters.set(id, { resolve, reject, timer });
    try {
      whisperChild.stdin.write(JSON.stringify(Object.assign({ id }, msg)) + "\n");
    } catch (e) {
      clearTimeout(timer);
      whisperWaiters.delete(id);
      reject(e);
    }
  });
}

function whisperCall(msg, timeoutMs) {
  const run = () => whisperSend(msg, timeoutMs);
  const p = whisperQueue.then(run, run);
  whisperQueue = p.then(
    () => {},
    () => {}
  );
  return p;
}

async function whisperLoad(model, device) {
  const name = WHISPER_MODELS.has(String(model || "")) ? String(model) : "small";
  const dev = String(device || "auto").toLowerCase();
  const out = await whisperCall({ cmd: "load", model: name, device: dev === "cpu" || dev === "cuda" ? dev : "auto" }, 180000);
  whisperInfo = {
    ready: !!out.ok,
    model: out.model || name,
    device: out.device || null,
    compute: out.compute || null,
    error: null,
  };
  return out;
}

process.on("exit", () => {
  try {
    if (whisperChild) whisperChild.kill();
  } catch (e) {}
});

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    if (!isLocalRequest(req)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/live/status")) {
      sendJson(res, 200, {
        ok: true,
        hasKey: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()),
        model: "gpt-live-1",
        geminiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
        geminiModel: "gemini-3.8-live",
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/gemini/status")) {
      sendJson(res, 200, {
        ok: true,
        hasKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
        model: "gemini-3.8-live",
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/stt/status")) {
      const py = findPython();
      sendJson(res, 200, {
        ok: true,
        python: py,
        pythonOk: py === "python" ? true : fs.existsSync(py),
        worker: !!(whisperChild && whisperChild.exitCode == null),
        ready: !!whisperInfo.ready,
        model: whisperInfo.model,
        device: whisperInfo.device,
        compute: whisperInfo.compute,
        error: whisperInfo.error,
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/stt/load")) {
      const raw = await readBody(req, 4000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      try {
        const out = await whisperLoad(body.model, body.device);
        sendJson(res, out.ok ? 200 : 500, out);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message || "falha ao carregar Whisper" });
      }
      return;
    }
    if (req.method === "POST" && (url === "/api/stt" || url.startsWith("/api/stt?"))) {
      const q = new URL(url, "http://127.0.0.1");
      const lang = String(q.searchParams.get("lang") || "pt").slice(0, 8);
      const model = String(q.searchParams.get("model") || whisperInfo.model || "small");
      let audio;
      try {
        audio = await readRaw(req, 8 * 1024 * 1024);
      } catch (e) {
        sendJson(res, 413, { ok: false, error: e.message || "audio grande demais" });
        return;
      }
      if (!audio || audio.length < 64) {
        sendJson(res, 400, { ok: false, error: "audio vazio" });
        return;
      }
      if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
      const id = randomUUID();
      const wavFile = path.join(TMP, "stt-" + id + ".wav");
      fs.writeFileSync(wavFile, audio);
      try {
        if (!whisperInfo.ready || (WHISPER_MODELS.has(model) && model !== whisperInfo.model)) {
          await whisperLoad(model, "auto");
        }
        const out = await whisperCall({ cmd: "transcribe", path: wavFile, language: lang }, 90000);
        sendJson(res, 200, out);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message || "falha no Faster Whisper" });
      } finally {
        fs.unlink(wavFile, () => {});
        cleanupTmp();
      }
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/live/session")) {
      const key = (process.env.OPENAI_API_KEY || "").trim();
      if (!key) {
        sendJson(res, 503, { ok: false, error: "OPENAI_API_KEY ausente no .env" });
        return;
      }
      const raw = await readBody(req, 200000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      if (typeof body.sdp !== "string" || !body.sdp.trim()) {
        sendJson(res, 400, { ok: false, error: "SDP offer obrigatoria" });
        return;
      }
      const instructions = String(body.instructions || "").trim().slice(0, 8000) ||
        "Voce e um avatar voxel simpatico. Fale portugues do Brasil, breve e natural, com frases completas. Duas a quatro frases curtas. Sem markdown.";
      const voice = String(body.voice || "bossa").trim() || "bossa";
      const openaiRes = await fetch("https://api.openai.com/v1/live/sessions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            model: "gpt-live-1",
            instructions,
            audio: { output: { voice } },
            delegation: { type: "client" },
          },
          transport: { type: "webrtc", sdp: body.sdp },
        }),
      });
      const text = await openaiRes.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        sendJson(res, 502, { ok: false, error: "OpenAI devolveu resposta invalida" });
        return;
      }
      if (!openaiRes.ok) {
        const msg =
          (data && data.error && data.error.message) ||
          "Falha ao criar sessao GPT-Live";
        sendJson(res, openaiRes.status || 502, { ok: false, error: msg });
        return;
      }
      res.writeHead(201, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/avatars")) {
      sendJson(res, 200, { ok: true, default: DEFAULT_AVATAR, avatars: scanAvatars() });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/voices")) {
      const data = await runTts(["list"], 15000);
      sendJson(res, 200, data);
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/status")) {
      const conn = resolveOllama({});
      let ollama = false;
      try {
        const r = await ollamaFetch(conn, "/api/tags", { timeoutMs: 2500 });
        ollama = r.ok;
      } catch (e) {
        ollama = false;
      }
      sendJson(res, 200, {
        ok: true,
        sapi: fs.existsSync(TTS_EXE),
        ollama,
        ollamaModel: DEFAULT_OLLAMA_MODEL,
        ollamaHost: conn.host,
        ollamaPort: conn.port,
        defaultSystem: OLLAMA_SYSTEM,
        savedSystem: loadSavedSystem(),
        port: PORT,
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/ollama/conn")) {
      const saved = loadSavedOllama();
      const conn = resolveOllama({});
      sendJson(res, 200, {
        ok: true,
        endpoint: saved.endpoint || conn.host,
        port: saved.port || conn.port,
        hasKey: !!(saved.key || process.env.OLLAMA_API_KEY),
        defaults: DEFAULT_OLLAMA,
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/conn")) {
      const raw = await readBody(req, 8000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      const conn = resolveOllama(body);
      const prev = loadSavedOllama();
      const out = {
        endpoint: conn.host,
        port: conn.port,
        key: body.clearKey ? "" : body.key != null && String(body.key).length ? conn.key : prev.key || "",
      };
      fs.mkdirSync(path.dirname(OLLAMA_CONN_FILE), { recursive: true });
      fs.writeFileSync(OLLAMA_CONN_FILE, JSON.stringify(out, null, 2), "utf8");
      sendJson(res, 200, { ok: true, endpoint: out.endpoint, port: out.port, hasKey: !!out.key });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/start")) {
      const conn = resolveOllama({});
      try {
        const probe = await ollamaFetch(conn, "/api/tags", { timeoutMs: 1500 });
        if (probe.ok) {
          sendJson(res, 200, { ok: true, already: true, url: conn.url });
          return;
        }
      } catch (e) {}
      const exe = findOllamaApp();
      try {
        const child = spawn(exe, exe.toLowerCase().endsWith("ollama.exe") && !exe.toLowerCase().includes("app") ? ["serve"] : [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
        sendJson(res, 200, { ok: true, launched: true, path: exe });
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: "Nao consegui abrir o Ollama. Suba o app manualmente.",
          path: exe,
        });
      }
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/stop")) {
      function runKill(cmd, args) {
        return new Promise((resolve) => {
          const c = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
          c.on("close", () => resolve());
          c.on("error", () => resolve());
        });
      }
      try {
        if (process.platform === "win32") {
          await runKill("taskkill", ["/F", "/IM", "ollama.exe", "/T"]);
          await runKill("taskkill", ["/F", "/IM", "ollama app.exe", "/T"]);
        } else {
          await runKill("pkill", ["-f", "ollama"]);
        }
        sendJson(res, 200, { ok: true, stopped: true });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message || "nao consegui parar o Ollama" });
      }
      return;
    }
    if (
      (req.method === "GET" || req.method === "POST") &&
      url.startsWith("/api/ollama/models")
    ) {
      let body = {};
      if (req.method === "POST") {
        try {
          body = JSON.parse((await readBody(req, 8000)) || "{}");
        } catch (e) {
          body = {};
        }
      }
      const conn = resolveOllama(body);
      try {
        const r = await ollamaFetch(conn, "/api/tags", { timeoutMs: 8000 });
        const j = await r.json();
        const models = (j.models || []).map((m) => m.name).filter(Boolean);
        sendJson(res, 200, {
          ok: true,
          models,
          defaultModel: DEFAULT_OLLAMA_MODEL,
          url: conn.url,
        });
      } catch (e) {
        sendJson(res, 503, {
          ok: false,
          error: "Ollama nao respondeu em " + conn.url,
          models: [],
          defaultModel: DEFAULT_OLLAMA_MODEL,
          url: conn.url,
        });
      }
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/ollama/system")) {
      sendJson(res, 200, {
        ok: true,
        default: OLLAMA_SYSTEM,
        saved: loadSavedSystem(),
        current: loadSavedSystem() || OLLAMA_SYSTEM,
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/system")) {
      const raw = await readBody(req, 20000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      const system = String(body.system || "").trim().slice(0, 8000);
      fs.mkdirSync(path.dirname(SYSTEM_FILE), { recursive: true });
      if (!system) {
        try {
          fs.unlinkSync(SYSTEM_FILE);
        } catch (e) {}
        sendJson(res, 200, { ok: true, system: OLLAMA_SYSTEM, restored: true });
        return;
      }
      fs.writeFileSync(SYSTEM_FILE, JSON.stringify({ system }, null, 2), "utf8");
      sendJson(res, 200, { ok: true, system });
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/chat-stream")) {
      const raw = await readBody(req, 80000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      const userText = String(body.text || "").trim();
      if (!userText) {
        sendJson(res, 400, { ok: false, error: "Digite uma pergunta" });
        return;
      }
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const messages = [
        { role: "system", content: resolveSystem(body) },
        ...history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
        { role: "user", content: userText.slice(0, 2000) },
      ];
      const conn = resolveOllama(body);
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on("close", onClose);
      const timer = setTimeout(() => ac.abort(), 180000);
      try {
        const r = await fetch(conn.url + "/api/chat", {
          method: "POST",
          headers: ollamaHeaders(conn),
          signal: ac.signal,
          body: JSON.stringify({
            model: String(body.model || DEFAULT_OLLAMA_MODEL),
            stream: true,
            think: false,
            messages,
            options: {
              temperature: 0.5,
              num_predict: 160,
            },
          }),
        });
        if (!r.ok) {
          let err = "falha no Ollama";
          try {
            const j = await r.json();
            err = j.error || err;
          } catch (e) {}
          sendJson(res, 502, { ok: false, error: err });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
        });
        for await (const chunk of r.body) {
          res.write(chunk);
        }
        res.end();
      } catch (e) {
        if (e.name === "AbortError") {
          if (!res.headersSent) sendJson(res, 499, { ok: false, error: "cancelado" });
          else try { res.end(); } catch (e2) {}
        } else if (!res.headersSent) {
          sendJson(res, 503, { ok: false, error: e.message || "Ollama indisponivel" });
        } else {
          try { res.end(); } catch (e2) {}
        }
      } finally {
        clearTimeout(timer);
        req.off("close", onClose);
      }
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/ollama/chat")) {
      const raw = await readBody(req, 80000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      const userText = String(body.text || "").trim();
      if (!userText) {
        sendJson(res, 400, { ok: false, error: "Digite uma pergunta" });
        return;
      }
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const messages = [
        { role: "system", content: resolveSystem(body) },
        ...history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
        { role: "user", content: userText.slice(0, 2000) },
      ];
      try {
        const r = await ollamaFetch(resolveOllama(body), "/api/chat", {
          method: "POST",
          timeoutMs: 120000,
          body: {
            model: String(body.model || DEFAULT_OLLAMA_MODEL),
            stream: false,
            think: false,
            messages,
            options: {
              temperature: 0.5,
              num_predict: 160,
            },
          },
        });
        const j = await r.json();
        if (!r.ok) {
          sendJson(res, 502, { ok: false, error: j.error || "falha no Ollama" });
          return;
        }
        const reply = cleanReply((j.message && j.message.content) || "");
        if (!reply) {
          sendJson(res, 502, { ok: false, error: "Ollama devolveu resposta vazia" });
          return;
        }
        sendJson(res, 200, { ok: true, reply, model: body.model || DEFAULT_OLLAMA_MODEL });
      } catch (e) {
        const msg = e.name === "AbortError" ? "Ollama estourou o tempo" : e.message;
        sendJson(res, 503, { ok: false, error: msg || "Ollama indisponivel" });
      }
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/speak")) {
      const raw = await readBody(req, 20000);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON invalido" });
        return;
      }
      const text = String(body.text || "").trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: "Digite um texto" });
        return;
      }
      const id = randomUUID();
      const textFile = path.join(TMP, id + ".txt");
      const wavFile = path.join(TMP, id + ".wav");
      fs.writeFileSync(textFile, text, "utf8");
      const rate = Number(body.rate);
      const volume = Number(body.volume);
      const args = [
        "speak",
        "--voice",
        String(body.voice || ""),
        "--rate",
        String(Number.isFinite(rate) ? rate : 0),
        "--volume",
        String(Number.isFinite(volume) ? volume : 100),
        "--out",
        wavFile,
        "--text",
        textFile,
      ];
      const data = await runTts(args, 120000);
      cleanupTmp();
      sendJson(res, 200, {
        ok: true,
        audioUrl: "/tmp/" + id + ".wav",
        durationMs: data.durationMs,
        visemes: data.visemes || [],
        words: data.words || [],
        voice: data.voice || body.voice,
      });
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end("method");
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

const GEMINI_VOICES = new Set([
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
]);

function proxyGeminiLive(client) {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) {
    try {
      client.send(JSON.stringify({ type: "proxy-error", error: "GEMINI_API_KEY ausente no .env" }));
    } catch (e) {}
    client.close();
    return;
  }
  let google = null;
  let setupOk = false;
  const closeBoth = () => {
    try {
      if (google && (google.readyState === WebSocket.OPEN || google.readyState === WebSocket.CONNECTING)) {
        google.close();
      }
    } catch (e) {}
    try {
      if (client.readyState === 1) client.close();
    } catch (e) {}
  };
  client.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch (e) {
      return;
    }
    if (!google && msg && msg.type === "open") {
      let voice = String(msg.voice || "Kore").replace(/[^a-zA-Z0-9_-]/g, "") || "Kore";
      if (!GEMINI_VOICES.has(voice)) voice = "Kore";
      const model =
        String(msg.model || "gemini-3.8-live")
          .replace(/^models\//, "")
          .replace(/[^a-zA-Z0-9._-]/g, "") || "gemini-3.8-live";
      const instructions = String(msg.instructions || "").slice(0, 8000);
      const url =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
        encodeURIComponent(key);
      google = new WebSocket(url, { perMessageDeflate: false });
      google.on("open", () => {
        google.send(
          JSON.stringify({
            setup: {
              model: "models/" + model,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
                },
              },
              systemInstruction: {
                parts: [
                  {
                    text:
                      instructions ||
                      "Voce e um avatar voxel simpatico. Fale portugues do Brasil, breve e natural, com frases completas.",
                  },
                ],
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          })
        );
      });
      google.on("message", (payload) => {
        const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
        if (text.includes('"setupComplete"')) setupOk = true;
        if (client.readyState === 1) client.send(text);
      });
      google.on("error", () => {
        if (client.readyState === 1) {
          try {
            client.send(JSON.stringify({ type: "proxy-error", error: "falha na conexao Gemini" }));
          } catch (e) {}
        }
      });
      google.on("close", (code, reasonBuf) => {
        if (client.readyState === 1 && !setupOk) {
          const reason = reasonBuf ? String(reasonBuf).slice(0, 200) : "";
          try {
            client.send(
              JSON.stringify({
                type: "proxy-error",
                error:
                  "Gemini fechou a conexao" +
                  (code ? " (" + code + ")" : "") +
                  (reason ? ": " + reason : ""),
              })
            );
          } catch (e) {}
        }
        closeBoth();
      });
      return;
    }
    if (google && google.readyState === WebSocket.OPEN && msg && msg.type !== "open") {
      google.send(JSON.stringify(msg));
    }
  });
  client.on("close", closeBoth);
  client.on("error", closeBoth);
}

const geminiWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = req.url || "";
  // WebSocket ignora a same-origin policy: sem esta checagem qualquer site aberto no
  // navegador abriria este proxy e gastaria a GEMINI_API_KEY da maquina.
  if (!isLocalRequest(req)) {
    socket.destroy();
    return;
  }
  if (u.split("?")[0] === "/api/gemini/live") {
    geminiWss.handleUpgrade(req, socket, head, (ws) => proxyGeminiLive(ws));
    return;
  }
  socket.destroy();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Avatar Voxel em http://127.0.0.1:" + PORT);
});
