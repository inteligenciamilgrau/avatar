function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(f32, fromRate, toRate) {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const n = Math.floor(f32.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, f32.length - 1);
    const t = x - i0;
    out[i] = f32[i0] * (1 - t) + f32[i1] * t;
  }
  return out;
}

function encodeWav(int16, sampleRate) {
  const dataBytes = int16.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(buf, 44);
  pcm.set(int16);
  return new Blob([buf], { type: "audio/wav" });
}

function rmsF32(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

export class WhisperMic {
  constructor() {
    this.connected = false;
    this.paused = false;
    this.busy = false;
    this.stream = null;
    this.ctx = null;
    this.processor = null;
    this.src = null;
    this.chunks = [];
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.ignoreUntil = 0;
    this.onStatus = null;
    this.onUtterance = null;
    this.language = "pt";
    this.model = "small";
  }

  status(msg, kind) {
    if (this.onStatus) this.onStatus(msg, kind || "idle");
  }

  async connect() {
    if (this.connected) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createMediaStreamSource(this.stream);
    this.src = src;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = proc;
    proc.onaudioprocess = (e) => this.onAudio(e);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    this.connected = true;
    this.paused = false;
    this.chunks = [];
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.ignoreUntil = performance.now() + 350;
    this.status("Ouvindo…", "listen");
  }

  onAudio(e) {
    if (!this.connected || this.paused || this.busy) return;
    if (performance.now() < this.ignoreUntil) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const down = downsample(f32, this.ctx.sampleRate, 16000);
    const energy = rmsF32(down);
    const frameMs = (down.length / 16000) * 1000;
    const pcm = floatTo16(down);
    const speech = energy > 0.022;
    if (speech) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechMs = 0;
        this.status("Falando…", "listen");
      }
      this.speechMs += frameMs;
      this.silenceMs = 0;
      this.chunks.push(pcm);
    } else if (this.speaking) {
      this.silenceMs += frameMs;
      this.chunks.push(pcm);
      if (this.silenceMs >= 780 && this.speechMs >= 380) {
        this.flushUtterance();
      }
    } else {
      this.chunks.push(pcm);
      let kept = 0;
      const preroll = Math.ceil(0.28 * 16000);
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        kept += this.chunks[i].length;
        if (kept >= preroll) {
          this.chunks = this.chunks.slice(i);
          break;
        }
      }
    }
    if (this.speaking) {
      const samples = this.chunks.reduce((n, c) => n + c.length, 0);
      if (samples / 16000 >= 18) this.flushUtterance();
    }
  }

  flushUtterance() {
    if (this.busy) return;
    const chunks = this.chunks;
    this.chunks = [];
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < 16000 * 0.35) return;
    const int16 = new Int16Array(total);
    let o = 0;
    for (const c of chunks) {
      int16.set(c, o);
      o += c.length;
    }
    const blob = encodeWav(int16, 16000);
    this.emitUtterance(blob);
  }

  async emitUtterance(blob) {
    if (!this.onUtterance) return;
    this.busy = true;
    this.paused = true;
    try {
      await this.onUtterance(blob);
    } finally {
      this.busy = false;
      if (this.connected) {
        this.paused = false;
        this.ignoreUntil = performance.now() + 280;
        this.status("Ouvindo…", "listen");
      }
    }
  }

  pause() {
    this.paused = true;
    this.chunks = [];
    this.speaking = false;
  }

  resume() {
    if (!this.connected) return;
    this.paused = false;
    this.chunks = [];
    this.speaking = false;
    this.ignoreUntil = performance.now() + 280;
    this.status("Ouvindo…", "listen");
  }

  async transcribe(blob, extra) {
    const lang = (extra && extra.language) || this.language || "pt";
    const model = (extra && extra.model) || this.model || "small";
    const r = await fetch("/api/stt?lang=" + encodeURIComponent(lang) + "&model=" + encodeURIComponent(model), {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && j.error) || "falha no Faster Whisper");
    return j;
  }

  async disconnect() {
    this.connected = false;
    this.paused = true;
    this.busy = false;
    this.chunks = [];
    this.speaking = false;
    try {
      if (this.processor) this.processor.disconnect();
    } catch (e) {}
    try {
      if (this.src) this.src.disconnect();
    } catch (e) {}
    try {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (this.ctx) this.ctx.close();
    } catch (e) {}
    this.processor = null;
    this.src = null;
    this.stream = null;
    this.ctx = null;
    this.status("Whisper desconectado", "idle");
  }
}
