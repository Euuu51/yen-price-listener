// 語列 → 値段（train/words.py の移植。test_words.mjs で Python と突き合わせる）。
const SMALL = Object.fromEntries(
  ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen"].map((w, i) => [w, i]));
SMALL.oh = 0;
const TENS = Object.fromEntries(
  ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((w, i) => [w, 10 * (i + 2)]));
export const NUMWORDS = new Set([...Object.keys(SMALL), ...Object.keys(TENS), "hundred", "thousand", "million", "and", "a", "point"]);
const UNITS = new Set(["hundred", "thousand", "million"]);

export function toInt(words) {
  if (words.includes("point")) {
    const p = words.indexOf("point");
    if (p + 3 !== words.length || !["thousand", "million"].includes(words[p + 2])) return null;
    const d = SMALL[words[p + 1]];
    const left = toInt(words.slice(0, p));
    if (d === undefined || d > 9 || left === null || left >= 1000) return null;
    const unit = words[p + 2] === "million" ? 1000000 : 1000;
    return Math.floor((left * 10 + d) * unit / 10);
  }
  const toks = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) {
      let v = TENS[w];
      const nx = words[i + 1];
      if (nx in SMALL && SMALL[nx] > 0 && SMALL[nx] < 10) { v += SMALL[nx]; i++; }
      toks.push(v);
    } else if (w in SMALL) toks.push(SMALL[w]);
    else if (w === "a") {
      if (UNITS.has(words[i + 1])) toks.push(1); else return null;
    } else if (UNITS.has(w)) toks.push(w);
    else if (w === "and") { /* 読み飛ばす */ }
    else return null;
  }
  if (!toks.length || typeof toks[0] === "string") return null;
  let total = 0, cur = 0;
  for (const t of toks) {
    if (t === "hundred") {
      if (cur === 0 || cur >= 10) return null;   // twenty four hundred / thirteen hundred は読まない（2026-11-12）
      cur *= 100;
    } else if (t === "thousand") {
      if (cur === 0 || cur >= 1000 || total % 1000000) return null;
      total += cur * 1000; cur = 0;
    } else if (t === "million") {
      if (cur === 0 || total) return null;
      total = cur * 1000000; cur = 0;
    } else if (cur === 0) cur = t;
    else if (cur >= 100 && cur % 100 === 0 && t < 100) cur += t;
    // three fifty / fifteen fifty（2 つに分けた読み）は読まない（2026-11-12、売り手はこの言い方をしない）。train/words.py の SPLIT=0 と同じ
    else return null;
  }
  return total + cur;
}

// 言い直し（同じ語からの言い始め直し）があれば、言い直した後ろの位置。train/words.py の restart と同じ。
export function restart(run) {
  if (toInt(run) !== null) return 0;
  for (let j = 1; j < run.length; j++) if (run[j] === run[0] && toInt(run.slice(j)) !== null) return j;
  return 0;
}

// yen 直前の数の語の続き → [値, 続きの中での始まり] / null。train/words.py の price_of_run と同じ。
export function priceOfRun(run) {
  for (let j = restart(run); j < run.length; j++) { const v = toInt(run.slice(j)); if (v !== null) return [v, j]; }
  return null;
}

// words[k] が yen のとき、その直前の成り立つ最長の数 → [値, 数の始まりの位置] / null
export function priceBefore(words, k) {
  let best = null;
  for (let j = k - 1; j >= 0 && NUMWORDS.has(words[j]); j--) {
    const v = toInt(words.slice(j, k));
    if (v !== null) best = [v, j];
  }
  return best;
}

export function prices(words) {
  const out = [];
  words.forEach((w, k) => { if (w === "yen") { const p = priceBefore(words, k); if (p) out.push(p[0]); } });
  return out;
}
