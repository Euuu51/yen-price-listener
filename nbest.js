// 迷ったら候補を並べる（2026-11-13、train/nbest.py と同じ）。
// 値段の手がかりのフレームの前 WIN_BACK 秒〜後 WIN_FWD 秒を CTC の前置ビーム探索で読み直し、上位の読みを値段にまとめる。
import { NUMWORDS, priceOfRun } from "./words.js?v=20261114060003";
import { SUFFIX, SUFFIX_GAP } from "./listener.js?v=20261114060003";

export const WIN_BACK = 4.0, WIN_FWD = 0.3, WIDTH = 12, PRUNE = 1e-3;
const NEG = -1e30;
const lse = (a, b) => { if (a < b) [a, b] = [b, a]; return b <= NEG ? a : a + Math.log1p(Math.exp(b - a)); };

// P: フレームごとの確率（Float32Array の配列、各 V 個）、a..b（b は含まない）。→ [{pre: [[語 id, フレーム]...], lp}]
export function beam(P, a, b, width = WIDTH, prune = PRUNE) {
  let beams = new Map([["", { pre: [], pb: 0, pnb: NEG }]]);
  for (let k = a; k < b; k++) {
    const p = P[k], V = p.length;
    const lp = i => Math.log(Math.max(p[i], 1e-12));
    const cand = [];
    for (let i = 1; i < V; i++) if (p[i] >= prune) cand.push(i);
    const nb = new Map();
    const add = (pre, pb, pnb) => {
      const key = pre.map(x => x[0] + "@" + x[1]).join(",");
      const o = nb.get(key);
      if (o) { o.pb = lse(o.pb, pb); o.pnb = lse(o.pnb, pnb); } else nb.set(key, { pre, pb, pnb });
    };
    for (const { pre, pb, pnb } of beams.values()) {
      const tot = lse(pb, pnb);
      add(pre, tot + lp(0), NEG);
      if (pre.length) add(pre, NEG, pnb + lp(pre[pre.length - 1][0]));
      for (const i of cand) {
        const last = pre.length ? pre[pre.length - 1][0] : -1;
        add([...pre, [i, k]], NEG, (last === i ? pb : tot) + lp(i));
      }
    }
    beams = new Map([...nb.entries()].sort((x, y) => lse(y[1].pb, y[1].pnb) - lse(x[1].pb, x[1].pnb)).slice(0, width));
  }
  return [...beams.values()].map(v => ({ pre: v.pre, lp: lse(v.pb, v.pnb) })).sort((x, y) => y.lp - x.lp);
}

function merge(words) {                       // train/words.py の merge_suffix と同じ
  const out = [];
  for (const [t, w] of words) {
    if (w in SUFFIX) {
      const q = out[out.length - 1];
      if (q && q[1] in SUFFIX[w] && t - q[0] <= SUFFIX_GAP) out[out.length - 1] = [q[0], SUFFIX[w][q[1]]];
      else out.push([t, "<other>"]);
      continue;
    }
    out.push([t, w]);
  }
  return out;
}

export function valueOf(pre, vocab) {
  const ws = merge(pre.map(([i, f]) => [f * 0.02, vocab[i]])).map(x => x[1]);
  const yen = ws.includes("yen");
  const end = yen ? ws.lastIndexOf("yen") : ws.length;
  let j = end;
  while (j > 0 && NUMWORDS.has(ws[j - 1])) j--;
  const run = ws.slice(j, end);
  const p = run.length ? priceOfRun(run) : null;
  return [p ? p[0] : null, yen];
}

// → [{yen, p, hasYen}]（確率の高い順）
export function cands(P, fEnd, vocab, width = WIDTH) {
  const a = Math.max(0, fEnd - Math.round(WIN_BACK / 0.02));
  const b = Math.min(P.length, fEnd + Math.round(WIN_FWD / 0.02) + 1);
  const hyps = beam(P, a, b, width);
  if (!hyps.length) return [];
  const z = hyps[0].lp;
  const agg = new Map();
  let tot = 0;
  for (const { pre, lp } of hyps) {
    const q = Math.exp(lp - z);
    tot += q;
    const [v, y] = valueOf(pre, vocab);
    if (v == null) continue;
    const o = agg.get(v) || { yen: v, p: 0, hasYen: false };
    o.p += q; o.hasYen = o.hasYen || y;
    agg.set(v, o);
  }
  return [...agg.values()].map(o => ({ ...o, p: o.p / tot })).sort((x, y) => y.p - x.p);
}
