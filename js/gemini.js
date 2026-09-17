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

function b64FromInt16(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function int16FromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export class GeminiLiveSession {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.microphone = null;
    this.captureCtx = null;
    this.playCtx = null;
    this.processor = null;
    this.captureSrc = null;
    this.analyser = null;
    this.timeData = null;
    this.playGain = null;
    this.nextAt = 0;
    this.sources = [];
    this.onEvent = null;
    this.onStatus = null;
    this.sending = false;
    this._setupWait = null;
    this._closedEmitted = false;
  }

  status(msg) {
    if (this.onStatus) this.onStatus(msg);
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

  emit(type, extra) {
    if (this.onEvent) this.onEvent({ type, ...extra });
  }

  emitClosed() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.emit("session.closed", {});
  }

  async connect({ instructions, voice, model, withMic }) {
    await this.disconnect(true);
    this.ready = false;
    this._closedEmitted = false;
    this.status("Conectando Gemini Live…");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(proto + "://" + location.host + "/api/gemini/live");
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout ao abrir Gemini")), 12000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("WebSocket Gemini falhou"));
      };
    });
    ws.send(
      JSON.stringify({
        type: "open",
        voice: voice || "Kore",
        model: model || "gemini-3.8-live",
        instructions: instructions || "",
      })
    );
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onclose = () => {
      this.ready = false;
      this.status("Gemini desconectado");
      this.stopMic();
      this.emitClosed();
    };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Gemini nao completou o setup")), 20000);
      this._setupWait = (err) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve();
      };
    });
    this.ready = true;
    this.status("Gemini Live conectado");
    this.emit("session.started", {});
    if (withMic !== false) await this.startMic();
  }

  handleMessage(ev) {
    const data = ev.data;
    if (data instanceof Blob) {
      data.text().then((t) => this.handleParsed(t)).catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleParsed(new TextDecoder().decode(data));
      return;
    }
    this.handleParsed(typeof data === "string" ? data : String(data));
  }

  handleParsed(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.type === "proxy-error") {
      const err = msg.error || "erro Gemini";
      this.status(err);
      if (this._setupWait) {
        this._setupWait(new Error(err));
        this._setupWait = null;
      }
      return;
    }
    if (msg.error) {
      const err =
        (typeof msg.error === "string" && msg.error) ||
        msg.error.message ||
        "erro Gemini";
      this.status(err);
      if (this._setupWait) {
        this._setupWait(new Error(err));
        this._setupWait = null;
      }
      return;
    }
    if (msg.setupComplete) {
      if (this._setupWait) {
        this._setupWait();
        this._setupWait = null;
      }
      return;
    }
    if (msg.goAway) {
      this.status("Gemini encerrou a sessao");
      this.disconnect(true);
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) this.flushAudio();
    if (sc.inputTranscription && sc.inputTranscription.text) {
      this.emit("session.input_transcript.delta", {
        delta: sc.inputTranscription.text,
        finished: !!sc.inputTranscription.finished,
      });
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      this.emit("session.output_transcript.delta", {
        delta: sc.outputTranscription.text,
        finished: !!sc.outputTranscription.finished,
      });
    }
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) this.playPcm(part.inlineData.data);
        if (part.text) this.emit("session.output_transcript.delta", { delta: part.text });
      }
    }
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    return this.sendJson({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: t }] }],
        turnComplete: true,
      },
    });
  }

  sendPcm16(int16) {
    return this.sendJson({
      realtimeInput: {
        audio: { data: b64FromInt16(int16), mimeType: "audio/pcm;rate=16000" },
      },
    });
  }

  async startMic() {
    this.microphone = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.captureCtx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createMediaStreamSource(this.microphone);
    this.captureSrc = src;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = proc;
    proc.onaudioprocess = (e) => {
      if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const down = downsample(f32, ctx.sampleRate, 16000);
      this.sendPcm16(floatTo16(down));
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    this.sending = true;
  }

  stopMic() {
    this.sending = false;
    try {
      if (this.processor) this.processor.disconnect();
    } catch (e) {}
    try {
      if (this.captureSrc) this.captureSrc.disconnect();
    } catch (e) {}
    try {
      if (this.microphone) this.microphone.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (this.captureCtx) this.captureCtx.close();
    } catch (e) {}
    this.processor = null;
    this.captureSrc = null;
    this.microphone = null;
    this.captureCtx = null;
  }

  ensurePlay() {
    if (this.playCtx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.playCtx = ctx;
    const gain = ctx.createGain();
    this.playGain = gain;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;
    this.timeData = new Uint8Array(this.analyser.fftSize);
    gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.nextAt = 0;
    this.sources = [];
  }

  playPcm(b64) {
    this.ensurePlay();
    const ctx = this.playCtx;
    if (ctx.state === "suspended") ctx.resume();
    const int16 = int16FromB64(b64);
    if (!int16.length) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playGain);
    const now = ctx.currentTime;
    if (this.nextAt < now + 0.02) this.nextAt = now;
    src.start(this.nextAt);
    this.nextAt += buf.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };
  }

  flushAudio() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch (e) {}
    }
    this.sources = [];
    this.nextAt = 0;
  }

  async disconnect() {
    this.ready = false;
    if (this._setupWait) {
      this._setupWait(new Error("Gemini cancelado"));
      this._setupWait = null;
    }
    this.stopMic();
    this.flushAudio();
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch (e) {}
    try {
      if (this.playCtx) this.playCtx.close();
    } catch (e) {}
    this.playCtx = null;
    this.playGain = null;
    this.analyser = null;
    this.timeData = null;
    this.emitClosed();
  }
}
