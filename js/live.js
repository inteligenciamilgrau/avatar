export class GptLiveSession {
  constructor() {
    this.peer = null;
    this.events = null;
    this.microphone = null;
    this.audioEl = null;
    this.ready = false;
    this.finalized = false;
    this.closeTimer = 0;
    this.analyser = null;
    this.audioCtx = null;
    this.timeData = null;
    this.onEvent = null;
    this.onStatus = null;
    this.eventSeq = 0;
  }

  status(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  send(obj) {
    if (!this.events || this.events.readyState !== "open") return false;
    if (!obj.event_id) obj.event_id = "evt_" + ++this.eventSeq + "_" + Date.now();
    this.events.send(JSON.stringify(obj));
    return true;
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

  tapRemoteAudio(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AC();
      if (this.audioCtx.state === "suspended") this.audioCtx.resume();
      const src = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.7;
      this.timeData = new Uint8Array(this.analyser.fftSize);
      src.connect(this.analyser);
    } catch (e) {
      console.warn("analyser live", e);
    }
  }

  async connect({ instructions, voice, withMic }) {
    await this.disconnect(true);
    this.ready = false;
    this.finalized = false;
    this.status("Conectando GPT-Live…");

    const pc = new RTCPeerConnection();
    this.peer = pc;
    this.audioEl = new Audio();
    this.audioEl.autoplay = true;

    pc.addEventListener("track", (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      this.audioEl.srcObject = stream;
      this.tapRemoteAudio(stream);
      this.audioEl.play().catch(() => {});
    });

    if (withMic !== false) {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      for (const track of this.microphone.getAudioTracks()) {
        pc.addTrack(track, this.microphone);
      }
    }

    const dc = pc.createDataChannel("oai-events");
    this.events = dc;
    dc.addEventListener("message", (ev) => {
      let event;
      try {
        event = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (event.type === "session.started") {
        this.ready = true;
        this.status("GPT-Live conectado");
      } else if (event.type === "session.closed") {
        this.finalized = true;
        this.status("Sessao encerrada");
        this.cleanup();
      } else if (event.type === "error") {
        const msg = (event.error && event.error.message) || "erro GPT-Live";
        this.status(msg);
      }
      if (this.onEvent) this.onEvent(event);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== "complete") {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout ICE")), 10000);
        const onState = () => {
          if (pc.iceGatheringState !== "complete") return;
          clearTimeout(t);
          pc.removeEventListener("icegatheringstatechange", onState);
          resolve();
        };
        pc.addEventListener("icegatheringstatechange", onState);
        onState();
      });
    }
    const sdp = pc.localDescription && pc.localDescription.sdp;
    if (!sdp) throw new Error("SDP local ausente");

    const response = await fetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp, instructions, voice }),
    });
    const result = await response.json();
    if (!response.ok || !result.transport || !result.transport.sdp) {
      throw new Error((result && result.error) || "Falha ao criar sessao GPT-Live");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
    this.status("Aguardando session.started…");
    return result.session && result.session.id;
  }

  sendText(text) {
    return this.send({
      type: "session.commentary.append",
      delegation_id: null,
      content:
        "The user typed the following message. Reply now in spoken Brazilian Portuguese, naturally, in two to four short complete sentences: " +
        text,
    });
  }

  async disconnect(silent) {
    clearTimeout(this.closeTimer);
    if (this.ready && this.events && this.events.readyState === "open" && !silent) {
      this.send({ type: "session.close" });
      await new Promise((r) => {
        this.closeTimer = setTimeout(r, 2500);
        const prev = this.onEvent;
        const wrap = (ev) => {
          if (prev) prev(ev);
          if (ev && ev.type === "session.closed") r();
        };
        this.onEvent = wrap;
      });
    }
    this.cleanup();
  }

  cleanup() {
    clearTimeout(this.closeTimer);
    try {
      if (this.microphone) this.microphone.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (this.events) this.events.close();
    } catch (e) {}
    try {
      if (this.peer) this.peer.close();
    } catch (e) {}
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    this.microphone = null;
    this.events = null;
    this.peer = null;
    this.ready = false;
    this.analyser = null;
  }
}
