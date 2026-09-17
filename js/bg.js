export class Background {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cols = [];
    this.cubes = [];
    this.dpr = 1;
    this.running = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.w = this.canvas.width;
    this.h = this.canvas.height;
    const glyph = Math.max(14, Math.floor(18 * this.dpr));
    const n = Math.ceil(this.w / glyph);
    this.glyph = glyph;
    this.cols = Array.from({ length: n }, (_, i) => ({
      x: i * glyph,
      y: Math.random() * this.h,
      speed: 1.2 + Math.random() * 3.4,
      len: 8 + Math.floor(Math.random() * 18),
    }));
    if (!this.cubes.length) {
      this.cubes = Array.from({ length: 18 }, () => ({
        a: Math.random() * Math.PI * 2,
        r: 0.18 + Math.random() * 0.38,
        s: 6 + Math.random() * 16,
        z: 0.4 + Math.random() * 1.2,
        spin: (Math.random() - 0.5) * 0.8,
        hue: Math.random() > 0.55 ? "#d6ff2a" : "#39ff6a",
      }));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = (t) => {
      if (!this.running) return;
      this.draw(t / 1000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  draw(t) {
    const { ctx, w, h, glyph } = this;
    ctx.fillStyle = "rgba(2,6,3,0.28)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = glyph + "px Consolas, monospace";
    ctx.textBaseline = "top";
    for (const c of this.cols) {
      c.y += c.speed * this.dpr * 1.6;
      if (c.y - c.len * glyph > h) {
        c.y = -Math.random() * h * 0.3;
        c.speed = 1.2 + Math.random() * 3.4;
      }
      for (let i = 0; i < c.len; i++) {
        const y = c.y - i * glyph;
        if (y < -glyph || y > h) continue;
        const ch = Math.random() > 0.92 ? String(Math.random() > 0.5 ? 1 : 0) : "01".charAt((i + (t * 8)) & 1);
        const a = i === 0 ? 0.9 : Math.max(0.05, 0.55 - i / c.len);
        ctx.fillStyle = i === 0 ? `rgba(210,255,90,${a})` : `rgba(40,200,70,${a})`;
        ctx.fillText(ch, c.x, y);
      }
    }

    const cx = w * 0.38;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    for (const q of this.cubes) {
      const ang = q.a + t * q.z * 0.25;
      const x = Math.cos(ang) * R * q.r;
      const y = Math.sin(ang * 1.15) * R * q.r * 0.62;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang * q.spin);
      ctx.strokeStyle = q.hue;
      ctx.globalAlpha = 0.28 + q.z * 0.2;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.shadowColor = q.hue;
      ctx.shadowBlur = 12 * this.dpr;
      const s = q.s * this.dpr;
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }
    ctx.restore();
  }
}
