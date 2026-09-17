export const SAPI_TO_NAME = {
  0: "rest",
  1: "aa",
  2: "aa_max",
  3: "o",
  4: "e",
  5: "e",
  6: "e",
  7: "u",
  8: "o",
  9: "aa",
  10: "o",
  11: "aa",
  12: "s",
  13: "s",
  14: "s",
  15: "s",
  16: "s",
  17: "s",
  18: "s",
  19: "s",
  20: "s",
  21: "mbp",
};

export const OPENNESS = {
  rest: 0,
  mbp: 0,
  s: 0.28,
  e: 0.42,
  u: 0.38,
  o: 0.62,
  aa: 0.72,
  aa_max: 1,
};

const DIGRAPHS = [
  ["ão", "aa", 1.5],
  ["ães", "aa", 1.3],
  ["ãe", "aa", 1.3],
  ["õe", "o", 1.2],
  ["nh", "s", 0.7],
  ["lh", "s", 0.7],
  ["ch", "s", 0.75],
  ["nh", "s", 0.7],
  ["rr", "s", 0.7],
  ["ss", "s", 0.7],
  ["qu", "s", 0.55],
  ["gu", "s", 0.55],
];

function charViseme(ch) {
  const c = ch.toLowerCase();
  if ("áàãâa".includes(c)) return ["aa", 1.25];
  if ("éêe".includes(c)) return ["e", 1.1];
  if ("íiýy".includes(c)) return ["e", 0.9];
  if ("óôõo".includes(c)) return ["o", 1.15];
  if ("úuüw".includes(c)) return ["u", 1.05];
  if ("pbm".includes(c)) return ["mbp", 0.7];
  if ("fv".includes(c)) return ["s", 0.65];
  if (".!?".includes(c)) return ["rest", 1.8];
  if (",;:".includes(c)) return ["rest", 1.1];
  if (/\s/.test(c)) return ["rest", 0.45];
  if (/[0-9a-zçsxzjtdnlrgk]/.test(c)) return ["s", 0.6];
  return null;
}

export function textToVisemes(text) {
  const s = String(text || "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const slice = s.slice(i);
    let hit = null;
    for (const [g, vis, w] of DIGRAPHS) {
      if (slice.toLowerCase().startsWith(g)) {
        hit = [g.length, vis, w];
        break;
      }
    }
    if (!hit) {
      const one = charViseme(s[i]);
      if (one) hit = [1, one[0], one[1]];
      else hit = [1, null, 0];
    }
    if (hit[1]) tokens.push({ viseme: hit[1], weight: hit[2] });
    i += hit[0];
  }
  if (!tokens.length) return [{ t: 0, name: "rest" }];
  const total = tokens.reduce((a, t) => a + t.weight, 0) || 1;
  let acc = 0;
  return tokens.map((t) => {
    const item = { t: acc / total, name: t.viseme };
    acc += t.weight;
    return item;
  });
}

export function scaleTimeline(items, durationMs) {
  if (!items || !items.length || !durationMs) return items || [];
  const last = items[items.length - 1].t;
  if (!(last > 0)) return items.map((v) => ({ ...v, t: 0 }));
  const s = durationMs / last;
  return items.map((v) => ({ ...v, t: v.t * s }));
}

export function visemeAt(timeline, timeMs) {
  if (!timeline || !timeline.length) return { name: "rest", id: 0, t: 0, next: null };
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid].t <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  const cur = timeline[lo];
  const next = timeline[lo + 1] || null;
  return { ...cur, next };
}

export function sapiToName(id) {
  return SAPI_TO_NAME[id] || "s";
}

export function blendOpen(name, energy) {
  const base = OPENNESS[name] ?? 0.3;
  const e = Math.max(0, Math.min(1, energy * 3.2));
  let open = Math.max(base * 0.55, base * 0.35 + e * 0.75);
  if (name === "mbp") open = Math.min(open, 0.12);
  if (name === "rest" && e < 0.08) return "rest";
  if (open > 0.88) return "aa_max";
  if (open > 0.68) return name === "o" || name === "u" ? "o" : "aa";
  if (open < 0.1) return name === "mbp" ? "mbp" : "rest";
  return name;
}

export function visemeFromOpen(name, open) {
  const o = Math.max(0, Math.min(1, open));
  if (name === "mbp" && o < 0.2) return "mbp";
  if (o < 0.08) return name === "mbp" ? "mbp" : "rest";
  if (o >= 0.9) return "aa_max";
  if (o >= 0.68) return name === "o" || name === "u" ? "o" : "aa";
  if (o >= 0.48) return name === "o" ? "o" : name === "u" ? "u" : "e";
  if (o >= 0.22) return name === "o" ? "o" : name === "u" ? "u" : "s";
  return "s";
}
