import { textToVisemes, sapiToName } from "./lipsync.js";

export function speedToSapi(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10, Math.min(10, Math.round((n - 1) * 10)));
}

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export class TtsClient {
  constructor() {
    this.mode = "sapi";
    this.voices = [];
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.ctx = null;
    this.analyser = null;
    this.srcNode = null;
    this.timeData = null;
    this.freqData = null;
    this._utterance = null;
    this.unlocked = false;
    this.gen = 0;
  }

  async probe() {
    try {
      const r = await fetch("/api/status");
      const j = await r.json();
      if (j && j.sapi) {
        this.mode = "sapi";
        return true;
      }
    } catch (e) {
      /* file:// or server down */
    }
    this.mode = "browser";
    return false;
  }

  async loadSapiVoices() {
    const r = await fetch("/api/voices");
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "nao foi possivel listar as vozes");
    this.voices = (j.voices || []).slice().sort((a, b) => {
      const pa = a.culture && a.culture.toLowerCase().startsWith("pt") ? 0 : 1;
      const pb = b.culture && b.culture.toLowerCase().startsWith("pt") ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, "pt");
    });
    return this.voices;
  }

  loadBrowserVoices() {
    const grab = () =>
      (window.speechSynthesis ? speechSynthesis.getVoices() : []).map((v) => ({
        name: v.name,
        culture: v.lang,
        gender: "",
        uri: v.voiceURI,
        native: v,
      }));
    return new Promise((resolve) => {
      let list = grab();
      if (list.length) {
        this.voices = list;
        resolve(list);
        return;
      }
      if (!window.speechSynthesis) {
        this.voices = [];
        resolve([]);
        return;
      }
      const t = setTimeout(() => resolve(grab()), 800);
      speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(t);
          this.voices = grab();
          resolve(this.voices);
        },
        { once: true }
      );
    });
  }

  ensureAudioGraph() {
    if (this.analyser) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.srcNode = this.ctx.createMediaElementSource(this.audio);
    this.srcNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  async unlock() {
    this.ensureAudioGraph();
    if (this.ctx && this.ctx.state === "suspended") {
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    }
    if (this.unlocked) return;
    try {
      this.audio.src = SILENT_WAV;
      await Promise.race([
        this.audio.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("unlock timeout")), 500)),
      ]);
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.unlocked = true;
    } catch (e) {
      this.unlocked = false;
    }
  }

  rms() {
    if (!this.analyser || !this.timeData) return 0;
    this.analyser.getByteTimeDomainData(this.timeData);
    let s = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const n = (this.timeData[i] - 128) / 128;
      s += n * n;
    }
    return Math.sqrt(s / this.timeData.length);
  }

  bands() {
    if (!this.analyser || !this.freqData) return new Array(16).fill(0);
    this.analyser.getByteFrequencyData(this.freqData);
    const out = [];
    const n = 16;
    const step = Math.floor(this.freqData.length / n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < step; j++) m = Math.max(m, this.freqData[i * step + j] || 0);
      out.push(m / 255);
    }
    return out;
  }

  stop() {
    this.gen += 1;
    const done = this._playDone;
    this._playDone = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    if (window.speechSynthesis) speechSynthesis.cancel();
    this._utterance = null;
    if (done) done();
  }

  waitUntilDone(session) {
    return new Promise((resolve) => {
      this._playDone = resolve;
      const finish = () => {
        if (this._playDone === resolve) this._playDone = null;
        resolve();
      };
      if (session && session.audio) {
        const a = session.audio;
        a.onended = finish;
        a.play().then(() => {}, finish);
        return;
      }
      if (session && session.utterance) {
        session.utterance.onend = finish;
        session.utterance.onerror = finish;
        return;
      }
      finish();
    });
  }

  async speakSapi({ text, voice, speed, volume }) {
    const gen = this.gen;
    const r = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice,
        rate: speedToSapi(speed),
        volume: Math.round(Number(volume) || 100),
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "falha ao sintetizar");
    if (gen !== this.gen) throw new DOMException("cancelado", "AbortError");

    const visemes = (j.visemes || []).map((v) => ({
      t: v.t,
      id: v.id,
      name: sapiToName(v.id),
    }));
    const words = j.words || [];

    this.ensureAudioGraph();
    if (this.ctx && this.ctx.state === "suspended") {
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    }

    if (gen !== this.gen) throw new DOMException("cancelado", "AbortError");

    await new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        this.audio.removeEventListener("canplaythrough", onReady);
        this.audio.removeEventListener("loadeddata", onReady);
        this.audio.removeEventListener("error", onErr);
        if (err) reject(err);
        else resolve();
      };
      const onReady = () => done();
      const onErr = () => done(new Error("nao foi possivel tocar o audio"));
      const timer = setTimeout(() => done(new Error("timeout ao carregar o wav")), 12000);
      this.audio.addEventListener("canplaythrough", onReady);
      this.audio.addEventListener("loadeddata", onReady);
      this.audio.addEventListener("error", onErr);
      this.audio.src = j.audioUrl + "?t=" + Date.now();
      this.audio.load();
    });
    if (gen !== this.gen) throw new DOMException("cancelado", "AbortError");

    const durationMs = (this.audio.duration > 0 ? this.audio.duration * 1000 : 0) || j.durationMs || 0;
    const lastV = visemes.length ? visemes[visemes.length - 1].t : 0;
    const lastW = words.length ? words[words.length - 1].t : 0;
    const last = Math.max(lastV, lastW);
    let scaledV = visemes;
    let scaledW = words;
    if (durationMs > 0 && last > durationMs * 1.02) {
      const s = durationMs / last;
      scaledV = visemes.map((v) => ({ ...v, t: v.t * s }));
      scaledW = words.map((w) => ({ ...w, t: w.t * s }));
    }

    return {
      mode: "sapi",
      durationMs,
      visemes: scaledV,
      words: scaledW,
      audio: this.audio,
    };
  }

  speakBrowser({ text, voiceName, speed }) {
    if (!window.speechSynthesis) {
      return Promise.reject(new Error("Este navegador nao tem speechSynthesis"));
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const found = voices.find((v) => v.name === voiceName);
    if (found) u.voice = found;
    u.rate = Math.max(0.5, Math.min(2, Number(speed) || 1));
    u.lang = (found && found.lang) || "pt-BR";
    this._utterance = u;
    const phonetic = textToVisemes(text);
    const estMs = Math.max(800, (text.length / (11 * u.rate)) * 1000);
    const visemes = phonetic.map((p) => ({ t: p.t * estMs, name: p.name, id: -1 }));
    const words = [];
    u.onboundary = (ev) => {
      if (ev.name === "word" || ev.charIndex >= 0) {
        words.push({
          t: ev.elapsedTime || 0,
          text: text.substr(ev.charIndex, ev.charLength || 1),
          start: ev.charIndex,
          len: ev.charLength || 1,
        });
      }
    };
    return new Promise((resolve, reject) => {
      u.onerror = (e) => reject(new Error(e.error || "erro no speechSynthesis"));
      u.onstart = () => {
        resolve({
          mode: "browser",
          durationMs: estMs,
          visemes,
          words,
          audio: null,
          utterance: u,
        });
      };
      speechSynthesis.speak(u);
    });
  }
}
