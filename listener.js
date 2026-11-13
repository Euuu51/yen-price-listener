// 聞き取りの本体: 16 kHz の音 → log-mel → モデル（160 ms ごと、状態つき）→ 語 → 値段。
// ブラウザ（onnxruntime-web）でも node（onnxruntime-node）でも同じコードで動く。ort は外から渡す。
import { LogMel } from "./frontend.js";
import { NUMWORDS, priceOfRun } from "./words.js";
import { cands, WIN_BACK, WIN_FWD } from "./nbest.js";

// 新方式（2026-11-12、train/curve.py の listener_events と同じ）
export const GAP = 1.5;        // 数の語と語の間がこれ（秒、語の出た時刻どうし）より長く空いたら別の数（one hundred …… one thousand）。yen の前の間では切らない。売り手の配信で 1.2 秒は値段の頭を切った（80→78）、1.5 秒は 82
export const YENR = 0.3;       // 数の語（または数の語のすぐ後の <other>）の後 1 秒以内に yen の確率がこれを超えたら yen とみなす（curve.yen_rescue と同じ。1 = しない）。
                               // 2026-11-13 ユーザー「数字の後に聞こえる yen っぽいものを信用する」。t5k: 小さい yen（-12 dB）33 → 37/40、売り手 93 → 93、空振り 0.9 → 1.6/時
export const YENW = 1.0;
export const ALTR = 0.2;       // 僅差の候補: 値段を出した所の前後をビームで読み直し、確率が 1 位の ALTR 倍以上の値段を最大 ALTN 個並べる（2026-11-13、ユーザー「僅差の分岐が出たなら 4 通りぐらいまで」）
export const ALTN = 4;
export const TENT = 1;         // 仮の値段: yen を出さなかった所でも yen の確率の山がこれ以上なら読み直して「？」で出す（1 = しない）
export const RESCUE = 0.1;     // 「<other> hundred / thousand」の <other> を、その間の数の語の確率がこれ以上ならその語に（two ↔ to など）
const RESCUE_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety"];

// ty / teen（2026-11-12、train/words.py の merge_suffix と同じ）: forty を four + ty と分けて学んだモデル用。
// ty / teen が、直前の数字の語（ty は two〜nine、teen は three〜nine）から SUFFIX_GAP 秒以内ならくっつける。それ以外は <other>
const D = ["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TENW = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const TEENW = ["", "", "", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
export const SUFFIX = {
  ty: Object.fromEntries(D.map((d, i) => [d, TENW[i]]).filter(([d, w]) => d && w)),
  teen: Object.fromEntries(D.map((d, i) => [d, TEENW[i]]).filter(([d, w]) => d && w)),
};
export const SUFFIX_GAP = 1.0;

// words（[{w, t}]）の末尾 end（含まない）から前へ、数の語の続きの始まり。間が GAP より長い所で切る
export function runStart(words, end) {
  let j = end;
  while (j > 0 && NUMWORDS.has(words[j - 1].w) && (j === end || !NUMWORDS.has(words[j].w) || words[j].t - words[j - 1].t <= GAP)) j--;
  return j;
}

export class Listener {
  // ort: onnxruntime の名前空間、cfg: front.json、model: ArrayBuffer か パス
  static async create(ort, cfg, model, opts = {}) {
    const sess = await ort.InferenceSession.create(model, opts.session || {});
    return new Listener(ort, cfg, sess, opts);
  }

  constructor(ort, cfg, sess, opts) {
    this.ort = ort; this.cfg = cfg; this.sess = sess;
    this.rate = opts.rate ?? 0.44;
    this.yenr = opts.yenr ?? YENR;            // ¥ × rate = ₱（換算の言い直しを見分けるのにも使う）
    this.onWord = opts.onWord || (() => {});
    this.onPrice = opts.onPrice || (() => {});
    this.onPartial = opts.onPartial || (() => {});   // 組み上がり途中の数 {yen, words} / null（2026-11-11）
    this.onPeso = opts.onPeso || (() => {});         // 聞こえたペソ額 {t, php, words}（「数 + pesos」、2026-11-13）
    this.onAlts = opts.onAlts || (() => {});         // 僅差の候補 {t, alts: [{yen, p, hasYen}], tentative}（値段の 0.3 秒後に届く）
    this.altr = opts.altr ?? ALTR;
    this.tent = opts.tent ?? TENT;
    this.reset();
  }

  reset() {
    this.lm = new LogMel(this.cfg);
    this.frames = [];
    this.state = this.cfg.state_shapes.map(s => new this.ort.Tensor("float32", new Float32Array(s.reduce((a, b) => a * b)), s));
    this.outFrames = 0;                       // これまでに出た出力フレーム数（1 つ 20 ms）
    this.prev = 0;
    this.words = [];                          // [{w, t}]（直近 15 秒ぶん）
    this.probs = [];                          // [{t, w, p}] 直近 2 秒のフレームごとの、数の語で最も確からしい語と確率（RESCUE 用）
    this.last = null;                         // 直近に出した値段 {yen, t}
    this.pf = []; this.pfBase = 0;            // 直近のフレームごとの確率（候補の読み直し用、WIN_BACK + 1 秒ぶん）
    this.altq = [];                           // 読み直し待ち {f, t, yen, tentative}
    // 前の呼び出しが途中でも鎖は切らない（作り直すと同じ session を 2 つ同時に走らせてしまう）。古い呼び出しの結果は gen で捨てる
    this.busy = this.busy || Promise.resolve();
    this.gen = (this.gen || 0) + 1;
    this.ms = 0; this.calls = 0;
    this.pending = this.pending || 0; this.dropped = 0; this.errors = 0; this.lastError = "";
  }

  // 16 kHz の音を渡す。モデルの呼び出しは順番に行う（前の呼び出しが終わってから次）。
  push(samples) {
    this.frames.push(...this.lm.push(samples));
    const CH = this.cfg.chunk;
    while (this.frames.length >= CH) {
      const fr = this.frames.splice(0, CH);
      // 1 回でも失敗すると、つないだ約束の鎖が切れて以後ずっと何も出なくなる（2026-11-11 スマホで起きた）→ 失敗は数えて続ける。
      // 計算が追いつかず 20 個（3.2 秒）以上たまったら、古い方を捨てて今に追いつく
      if (this.pending > 20) { this.dropped++; continue; }
      this.pending++;
      const gen = this.gen;
      this.busy = this.busy.then(() => this.step(fr, gen))
        .catch(e => { this.errors++; this.lastError = String(e && e.message || e); console.error(e); })
        .finally(() => { this.pending--; });
    }
    return this.busy;
  }

  async step(fr, gen) {
    if (gen !== this.gen) return;                               // 作り直す前に積んだ分は捨てる
    const CH = this.cfg.chunk, ort = this.ort;
    const f = new Float32Array(40 * CH);
    for (let t = 0; t < CH; t++) for (let j = 0; j < 40; j++) f[j * CH + t] = fr[t][j];
    const feeds = { feats: new ort.Tensor("float32", f, [1, 40, CH]) };
    this.cfg.inputs.slice(1).forEach((n, k) => { feeds[n] = this.state[k]; });
    const t0 = performance.now();
    const r = await this.sess.run(feeds);
    if (gen !== this.gen) return;                               // 途中で作り直された
    this.ms += performance.now() - t0; this.calls++;
    this.state = this.cfg.outputs.slice(1).map(n => r[n]);
    const L = r.logits.data, V = this.cfg.vocab.length, T = CH / 2;
    if (!this.rid) this.rid = RESCUE_WORDS.map(w => this.cfg.vocab.indexOf(w));
    for (let t = 0; t < T; t++) {
      let a = 0;
      for (let v = 1; v < V; v++) if (L[v * T + t] > L[a * T + t]) a = v;
      const time = (this.outFrames + t - (this.cfg.lookahead || 0)) * 0.02;   // 先読みのモデルは出力が lookahead だけ遅れて出る
      let z = 0; const mx = L[a * T + t];
      for (let v = 0; v < V; v++) z += Math.exp(L[v * T + t] - mx);
      let bw = 0, bp = 0;
      this.rid.forEach((v, k) => { const p = Math.exp(L[v * T + t] - mx) / z; if (p > bp) { bp = p; bw = k; } });
      this.probs.push({ t: time, w: RESCUE_WORDS[bw], p: bp });
      while (this.probs.length && this.probs[0].t < time - 2) this.probs.shift();
      const pv = new Float32Array(V);
      for (let v = 0; v < V; v++) pv[v] = Math.exp(L[v * T + t] - mx) / z;
      this.pf.push(pv);
      const keep = Math.round((WIN_BACK + WIN_FWD + 1) / 0.02);
      if (this.pf.length > keep) { this.pf.splice(0, this.pf.length - keep); }
      this.pfBase = this.outFrames + t + 1 - this.pf.length;
      if (a !== this.prev && a !== 0) this.word(this.cfg.vocab[a], time);
      this.prev = a;
      if (this.yenr < 1) {                                       // yen の拾い直し（curve.yen_rescue と同じ順: その時点の最後の語を見る）
        if (this.yid === undefined) this.yid = this.cfg.vocab.indexOf("yen");
        const py = Math.exp(L[this.yid * T + t] - mx) / z;
        const n = this.words.length, q = this.words[n - 1], q0 = this.words[n - 2];
        if (a !== this.yid && py >= this.yenr && q) {
          if (NUMWORDS.has(q.w) && time - q.t <= YENW) this.word("yen", time);
          else if (q.w === "<other>" && q0 && NUMWORDS.has(q0.w) && time - q0.t <= YENW) { this.words.pop(); this.word("yen", q.t); }
        }
      }
      this.altStep(this.outFrames + t, time);
    }
    this.outFrames += T;
  }

  // 読み直し: 値段のフレームから WIN_FWD 秒たったら前後をビームで読み、僅差の候補を出す。仮の値段（yen の確率の山）もここで
  altStep(g, time) {
    const W = Math.round(WIN_FWD / 0.02);
    if (this.tent < 1) {                                          // yen の確率の山（前後 W フレームで最大）を W フレーム遅れで見つける
      const yid = this.yid ?? (this.yid = this.cfg.vocab.indexOf("yen"));
      const c = g - W, k = c - this.pfBase;
      if (k - W >= 0) {
        const py = this.pf[k][yid];
        let isPeak = py >= this.tent;
        for (let j = k - W; isPeak && j <= k + W; j++) if (this.pf[j][yid] > py) isPeak = false;
        const tc = c * 0.02;
        if (isPeak && !this.words.some(x => x.w === "yen" && Math.abs(x.t - tc) < 1.5)) this.altq.push({ f: c, t: tc, yen: null, tentative: true });
      }
    }
    while (this.altq.length && this.altq[0].f + W <= g) {
      const q = this.altq.shift();
      if (q.tentative && this.words.some(x => x.w === "yen" && Math.abs(x.t - q.t) < 1.5)) continue;
      const P = this.pf.slice(Math.max(0, q.f - this.pfBase - Math.round(WIN_BACK / 0.02)));
      const off = this.pfBase + this.pf.length - P.length;
      const c = cands(P, q.f - off, this.cfg.vocab);
      if (!c.length) continue;
      const top = c[0].p;
      const alts = [];
      if (q.yen != null) alts.push({ yen: q.yen, p: (c.find(x => x.yen === q.yen) || { p: 0 }).p, hasYen: true });
      for (const x of c) if (x.p >= this.altr * top && !alts.some(y => y.yen === x.yen)) alts.push(x);
      const all = [...alts];                                       // ペソで確定する時は、並べなかった候補も含めて上位 ALTN 個から選ぶ
      for (const x of c) if (!all.some(y => y.yen === x.yen)) all.push(x);
      this.onAlts({ t: q.t, alts: alts.slice(0, ALTN), all: all.slice(0, ALTN), tentative: q.tentative });
    }
  }

  word(w, t) {
    if (w in SUFFIX) {                                            // ty / teen: 直前の数字の語にくっつけて、その語として出し直す
      const q = this.words[this.words.length - 1];
      if (q && q.w in SUFFIX[w] && t - q.t <= SUFFIX_GAP) { this.words.pop(); return this.word(SUFFIX[w][q.w], q.t); }
      w = "<other>";
    }
    const pw = this.words[this.words.length - 1];
    if ((w === "hundred" || w === "thousand") && pw && pw.w === "<other>" && t - pw.t < 0.8) {   // RESCUE（curve.rescue_words と同じ窓）
      let best = null;
      for (const f of this.probs) if (f.t >= pw.t - 0.1 && f.t < t && (!best || f.p > best.p)) best = f;
      if (best && best.p >= RESCUE) pw.w = best.w;
    }
    this.words.push({ w, t });
    while (this.words.length && this.words[0].t < t - 15) this.words.shift();
    this.onWord(w, t);
    if (w === "pesos") {                                          // 「数 + pesos」: yen と同じ規則で数を読む（train/nbest.pesos_of と同じ）
      this.onPartial(null);
      const recent = this.words.filter(x => t - x.t < 8), ws = recent.map(x => x.w);
      let j = ws.length - 1;
      while (j > 0 && NUMWORDS.has(ws[j - 1])) j--;
      const p = j < ws.length - 1 ? priceOfRun(ws.slice(j, ws.length - 1)) : null;
      if (p) this.onPeso({ t, php: p[0], words: ws.slice(j + p[1], ws.length - 1).join(" ") });
      return;
    }
    if (w !== "yen") {                                            // 途中の数: 末尾に続く数の語を、今の時点で数に直す
      if (!NUMWORDS.has(w)) { this.onPartial(null); return; }      // 数の語が途切れたら（yen と同じく）値段にはならない
      const rw = this.words.filter(x => t - x.t < 8), ws = rw.map(x => x.w);
      const j = runStart(rw, rw.length);
      const p = priceOfRun(ws.slice(j));
      if (p) this.onPartial({ yen: p[0], t, words: ws.slice(j + p[1]).join(" ") });
      return;
    }
    this.onPartial(null);
    const recent = this.words.filter(x => t - x.t < 8);         // 数の語は yen の前 8 秒以内（realeval と同じ）
    const ws = recent.map(x => x.w);
    const j = runStart(recent, ws.length - 1);                   // yen の直前に続く数の語（長い間で切る）
    const p = priceOfRun(ws.slice(j, ws.length - 1));             // 言い直しがあれば後ろから（train/words.py と同じ規則）
    if (!p) return;
    const yen = p[0], start = recent[j + p[1]].t;
    let kind = "price";
    const L = this.last;
    if (L && t - L.t < 10) {
      const peso = L.yen * this.rate;
      if (Math.abs(yen - peso) <= 0.15 * peso) kind = "peso";      // 「X yen or Y pesos」の Y を yen と聞いた
      else if (yen === L.yen) kind = "repeat";                    // 同じ値段の言い直し
    }
    this.altq.push({ f: Math.round(t / 0.02) + (this.cfg.lookahead || 0), t, yen, tentative: false });
    if (kind === "price") this.last = { yen, t };
    else if (kind === "repeat") this.last.t = t;
    this.onPrice({ yen, kind, t, start, words: ws.slice(j + p[1]).join(" ") });
  }
}
