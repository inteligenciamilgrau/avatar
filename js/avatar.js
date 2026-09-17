// Valores do avatar base. Um avatar.json pode sobrescrever qualquer um deles:
// olhos em outra posicao, brilho de outra cor, queixo em outra altura.
const DEFAULT_EYES = [
  { x: 0.385, y: 0.445, rx: 0.09, ry: 0.07 },
  { x: 0.615, y: 0.445, rx: 0.09, ry: 0.07 },
];
const DEFAULT_GLOW = { inner: "210,255,80", outer: "80,220,40", radius: 0.055 };
const DEFAULT_JAW = { top: 0.54, bottom: 0.63, left: 0.18, width: 0.64, height: 0.32 };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("falha ao carregar " + src));
    img.src = src;
  });
}

function makeJawMask(w, h, jaw) {
  const j = Object.assign({}, DEFAULT_JAW, jaw || {});
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, h * j.top, 0, h * j.bottom);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = g;
  ctx.fillRect(w * j.left, h * j.top, w * j.width, h * j.height);
  const fade = ctx.createRadialGradient(w * 0.5, h * 0.68, h * 0.08, w * 0.5, h * 0.68, h * 0.28);
  fade.addColorStop(0, "rgba(255,255,255,1)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
  return c;
}

function makeEyesMask(w, h, eyes) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  for (const eye of eyes) {
    ctx.save();
    ctx.translate(eye.x, eye.y);
    ctx.scale(eye.rx, eye.ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.7, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return c;
}

export class VoxelAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.files = {};
    this.blinkSrc = null;
    this.eyes = DEFAULT_EYES;
    this.glow = DEFAULT_GLOW;
    this.jaw = DEFAULT_JAW;
    this.images = {};
    this.blinkImg = null;
    this.scratch = document.createElement("canvas");
    this.scratchCtx = this.scratch.getContext("2d");
    this.mouthMask = null;
    this.eyeMask = null;
    this.bufW = 0;
    this.bufH = 0;
    this.weights = { rest: 1 };
    this.target = "rest";
    this.blink = 0;
    this.blinkTarget = 0;
    this.speaking = false;
    this.energy = 0;
    this.running = false;
    this.nextBlink = 1200;
    this.blinkUntil = 0;
    this.onFrame = null;
    this.mouthMaskEnabled = true;
    this.lookX = 0;
    this.lookY = 0;
    this.lookR = 0;
    this.lookTx = 0;
    this.lookTy = 0;
    this.lookTr = 0;
    this.nextLook = 800;
  }

  // Recebe o avatar vindo de /api/avatars. Pode ser chamado de novo para trocar
  // de avatar sem recarregar a pagina.
  async load(avatar) {
    if (avatar) {
      this.files = avatar.visemes || {};
      this.blinkSrc = avatar.blink || null;
      this.eyes = avatar.eyes && avatar.eyes.length ? avatar.eyes : DEFAULT_EYES;
      this.glow = Object.assign({}, DEFAULT_GLOW, avatar.glow || {});
      this.jaw = Object.assign({}, DEFAULT_JAW, avatar.jaw || {});
    }
    if (!this.files.rest) throw new Error("avatar 2D sem visemes/rest");
    const images = {};
    await Promise.all(
      Object.entries(this.files).map(async ([k, src]) => {
        images[k] = await loadImage(src);
      })
    );
    // So troca depois que tudo carregou, para nao piscar meio avatar na tela.
    this.images = images;
    this.weights = { rest: 1 };
    this.target = "rest";
    this.blinkImg = this.blinkSrc ? await loadImage(this.blinkSrc).catch(() => null) : null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const css = Math.max(320, Math.floor(Math.min(rect.width || 640, rect.height || 640)));
    const size = Math.min(1024, Math.round(css * dpr));
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    this.bufW = size;
    this.bufH = size;
    this.scratch.width = size;
    this.scratch.height = size;
    this.mouthMask = makeJawMask(size, size, this.jaw);
    this.eyeMask = makeEyesMask(
      size,
      size,
      this.eyes.map((e) => ({
        x: size * e.x,
        y: size * e.y,
        rx: size * e.rx,
        ry: size * e.ry,
      }))
    );
  }

  setViseme(name) {
    this.target = this.images[name] ? name : "rest";
  }

  setSpeaking(v) {
    this.speaking = !!v;
    if (!v) this.target = "rest";
  }

  setEnergy(v) {
    this.energy = Math.max(0, Math.min(1, v));
  }

  setMouthMask(on) {
    this.mouthMaskEnabled = !!on;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      this.tick(t);
      this.draw(t);
      if (this.onFrame) this.onFrame(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  tick(t) {
    if (t >= this.nextBlink && t >= this.blinkUntil) {
      this.blinkTarget = 1;
      this.blinkUntil = t + 140;
      this.nextBlink = t + 2800 + Math.random() * 4200;
    }
    if (t >= this.blinkUntil) this.blinkTarget = 0;
    this.blink += (this.blinkTarget - this.blink) * (this.blinkTarget > this.blink ? 0.55 : 0.28);

    if (t >= this.nextLook) {
      const span = this.speaking ? 0.55 : 1;
      this.lookTx = (Math.random() * 2 - 1) * 0.034 * span;
      this.lookTy = (Math.random() * 2 - 1) * 0.022 * span;
      this.lookTr = (Math.random() * 2 - 1) * 0.05 * span;
      this.nextLook = t + 1600 + Math.random() * 2800;
    }
    const ease = 0.018;
    this.lookX += (this.lookTx - this.lookX) * ease;
    this.lookY += (this.lookTy - this.lookY) * ease;
    this.lookR += (this.lookTr - this.lookR) * ease;

    const names = Object.keys(this.images);
    for (const n of names) {
      const want = n === this.target ? 1 : 0;
      const cur = this.weights[n] || 0;
      const k = n === this.target ? 0.55 : 0.34;
      this.weights[n] = cur + (want - cur) * k;
      if (this.weights[n] < 0.01 && want === 0) this.weights[n] = 0;
    }
  }

  drawMasked(img, mask, alpha) {
    if (alpha < 0.02 || !img || !mask) return;
    const { scratch: s, scratchCtx: sc, bufW: w, bufH: h, ctx } = this;
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalAlpha = 1;
    sc.globalCompositeOperation = "copy";
    sc.clearRect(0, 0, w, h);
    sc.drawImage(img, 0, 0, w, h);
    sc.globalCompositeOperation = "destination-in";
    sc.drawImage(mask, 0, 0, w, h);
    sc.globalCompositeOperation = "source-over";
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(s, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  draw(now) {
    const { ctx, bufW: w, bufH: h } = this;
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    const talk = this.speaking ? 1 : 0;
    const sway = Math.sin(t * 0.33) * 0.022 + Math.sin(t * 0.71) * 0.008 + this.lookX;
    const bob =
      Math.sin(t * 0.62) * 0.016 +
      Math.sin(t * 1.35) * 0.005 +
      this.lookY +
      Math.sin(t * 5.4) * 0.007 * talk * (0.35 + this.energy);
    const rot =
      Math.sin(t * 0.27) * 0.038 +
      Math.sin(t * 0.83) * 0.01 +
      this.lookR +
      Math.sin(t * 4.1) * 0.012 * talk;
    const breathe = 1.015 + Math.sin(t * 1.05) * 0.012;
    ctx.save();
    ctx.translate(w / 2 + sway * w, h / 2 + bob * h);
    ctx.rotate(rot);
    ctx.scale(breathe, breathe);
    ctx.translate(-w / 2, -h / 2);

    const rest = this.images.rest;
    if (rest) ctx.drawImage(rest, 0, 0, w, h);

    const entries = Object.entries(this.weights)
      .filter(([n, a]) => n !== "rest" && a > 0.02)
      .sort((a, b) => a[1] - b[1]);
    for (const [n, a] of entries) {
      const img = this.images[n];
      if (!img) continue;
      if (this.mouthMaskEnabled) {
        this.drawMasked(img, this.mouthMask, a);
      } else {
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(img, 0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    }

    if (this.blink > 0.03 && this.blinkImg) {
      this.drawMasked(this.blinkImg, this.eyeMask, this.blink);
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const pulse = 0.18 + Math.sin(t * 3.2) * 0.06 + this.energy * 0.28;
    const r = w * (this.glow.radius || DEFAULT_GLOW.radius);
    for (const eye of this.eyes) {
      this.glowEye(w * eye.x, h * eye.y, r, pulse);
    }
    ctx.restore();

    ctx.restore();
  }

  glowEye(x, y, r, a) {
    const inner = this.glow.inner || DEFAULT_GLOW.inner;
    const outer = this.glow.outer || DEFAULT_GLOW.outer;
    const g = this.ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, `rgba(${inner},${0.55 * a})`);
    g.addColorStop(0.45, `rgba(${outer},${0.22 * a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
