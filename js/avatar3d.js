import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const MAP = {
  rest: {},
  mbp: { mbp: 1 },
  s: { s: 1 },
  e: { e: 1 },
  aa: { aa: 1 },
  aa_max: { ah: 1 },
  o: { o: 1 },
  u: { u: 1 },
};

export class Avatar3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.root = null;
    this.morphMeshes = [];
    this.rings = [];
    this.weights = {};
    this.target = "rest";
    this.running = false;
    this.active = false;
    this.ready = false;
    this.nextBlink = 2000;
    this.blinkUntil = 0;
    this.blink = 0;
    this.head = null;
    this.headBase = { x: 0, y: 0, z: 0 };
    this.look = { y: 0, x: 0, z: 0 };
    this.lookT = { y: 0, x: 0, z: 0 };
    this.nextLook = 900;
    this.speaking = false;
  }

  async load() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
    camera.position.set(0.55, 0.22, 4.15);
    this.camera = camera;

    const controls = new OrbitControls(camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 2.4;
    controls.maxDistance = 9;
    controls.target.set(0, 0.05, 0);
    controls.autoRotate = false;
    this.controls = controls;

    scene.add(new THREE.AmbientLight(0x1a3a22, 0.7));
    const key = new THREE.DirectionalLight(0xc8ff66, 1.35);
    key.position.set(2.4, 2.2, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe070, 0.85);
    rim.position.set(-2.2, 1.4, -2.6);
    scene.add(rim);
    const fill = new THREE.PointLight(0x44ff88, 2.2, 12);
    fill.position.set(0, 0.4, 2.2);
    scene.add(fill);

    const gltf = await new GLTFLoader().loadAsync("assets/voxel_avatar.glb");
    const root = gltf.scene;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (obj.geometry && obj.geometry.attributes.color) mat.vertexColors = true;
        mat.side = THREE.FrontSide;
        if (/ring|holo/i.test(obj.name)) {
          mat.emissive = new THREE.Color(0xffd24a);
          mat.emissiveIntensity = 1.8;
          mat.toneMapped = false;
        } else if (/sat/i.test(obj.name)) {
          mat.emissive = new THREE.Color(0x66ff88);
          mat.emissiveIntensity = 0.9;
        } else {
          mat.roughness = 0.42;
          mat.metalness = 0.16;
          mat.emissive = new THREE.Color(0x14330f);
          mat.emissiveIntensity = 0.45;
        }
      }
      if (obj.morphTargetDictionary && obj.morphTargetInfluences) {
        this.morphMeshes.push(obj);
      }
      if (/^Ring/i.test(obj.name) || obj.name === "HoloBase") this.rings.push(obj);
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(center);
    const s = 2.85 / Math.max(size.x, size.y, size.z);
    root.scale.setScalar(s);

    const head = new THREE.Group();
    const keep = [];
    root.children.slice().forEach((ch) => {
      if (/^Ring/i.test(ch.name) || ch.name === "HoloBase" || /^Sat/i.test(ch.name)) return;
      keep.push(ch);
    });
    for (const ch of keep) head.add(ch);
    root.add(head);
    this.head = head;
    this.headBase = { x: head.position.x, y: head.position.y, z: head.position.z };
    this.root = root;
    scene.add(root);

    this.ready = true;
    this.resize();
  }

  setActive(v) {
    this.active = !!v;
    if (this.controls) this.controls.enabled = this.active;
    if (this.active) this.resize();
  }

  setViseme(name) {
    this.target = MAP[name] ? name : "rest";
  }

  setSpeaking(v) {
    this.speaking = !!v;
  }

  resize() {
    if (!this.renderer) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      this.tick(t);
      if (this.active && this.ready) {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  tick(t) {
    const want = MAP[this.target] || {};
    const names = new Set(["aa", "ah", "o", "u", "e", "mbp", "s", "blk"]);
    for (const n of names) {
      const goal = n === "blk" ? this.blink : want[n] || 0;
      const cur = this.weights[n] || 0;
      this.weights[n] = cur + (goal - cur) * 0.28;
    }
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const inf = mesh.morphTargetInfluences;
      if (!dict || !inf) continue;
      for (const n of names) {
        if (dict[n] == null) continue;
        inf[dict[n]] = this.weights[n] || 0;
      }
    }
    if (t >= this.nextBlink && t >= this.blinkUntil) {
      this.blink = 1;
      this.blinkUntil = t + 140;
      this.nextBlink = t + 2800 + Math.random() * 4200;
    }
    if (t >= this.blinkUntil) this.blink = 0;
    const sec = t / 1000;
    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].rotation.z = sec * (0.12 + i * 0.05);
    }

    if (t >= this.nextLook) {
      const span = this.speaking ? 0.45 : 1;
      this.lookT.y = (Math.random() * 2 - 1) * 0.22 * span;
      this.lookT.x = (Math.random() * 2 - 1) * 0.1 * span;
      this.lookT.z = (Math.random() * 2 - 1) * 0.06 * span;
      this.nextLook = t + 1700 + Math.random() * 2600;
    }
    this.look.y += (this.lookT.y - this.look.y) * 0.02;
    this.look.x += (this.lookT.x - this.look.x) * 0.02;
    this.look.z += (this.lookT.z - this.look.z) * 0.02;
    if (this.head) {
      const talk = this.speaking ? 1 : 0;
      this.head.rotation.y = this.look.y + Math.sin(sec * 0.35) * 0.08 + Math.sin(sec * 0.8) * 0.02;
      this.head.rotation.x =
        this.look.x + Math.sin(sec * 0.48) * 0.045 + Math.sin(sec * 5.2) * 0.03 * talk;
      this.head.rotation.z = this.look.z + Math.sin(sec * 0.29) * 0.03;
      this.head.position.y = this.headBase.y + Math.sin(sec * 1.12) * 0.028 + Math.sin(sec * 0.55) * 0.012;
    }
  }
}
