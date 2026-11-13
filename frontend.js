// log-mel（40 次元、25 ms 窓 / 10 ms シフト）と、平均の高さの指数移動平均を引く前処理。
// train.py の Frontend.raw と同じ値を出す（front.json の窓と mel 行列をそのまま使う）。
// AudioWorklet でも node でも動くよう、外の物に頼らない。

export class LogMel {
  constructor(cfg) {
    this.nfft = cfg.n_fft; this.hop = cfg.hop; this.wl = cfg.win_length;
    this.nb = this.nfft / 2 + 1;
    // 窓は n_fft の真ん中に置く（torch.stft と同じ）
    this.win = new Float32Array(this.nfft);
    const off = Math.floor((this.nfft - this.wl) / 2);
    for (let i = 0; i < this.wl; i++) this.win[off + i] = cfg.window[i];
    this.fb = cfg.mel_fb.map(r => Float32Array.from(r));       // (40, 257)
    this.eps = cfg.log_eps; this.a = cfg.ema_a; this.ema = null;
    this.perBin = !!cfg.per_bin;                                // true: mel の帯ごとに移動平均を引く（train.py の per_bin）
    this.buf = new Float32Array(0);                             // まだフレームにならない音
    // FFT の下ごしらえ
    const n = this.nfft;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    this.re = new Float64Array(n); this.im = new Float64Array(n); this.pow = new Float64Array(this.nb);
  }

  fft() {
    const n = this.nfft, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { const j = this.rev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], sn = this.sin[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // 1 フレーム（n_fft 点）→ 40 次元（EMA を引いた後）
  frame(x, o) {
    for (let i = 0; i < this.nfft; i++) { this.re[i] = x[o + i] * this.win[i]; this.im[i] = 0; }
    this.fft();
    for (let k = 0; k < this.nb; k++) this.pow[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
    const m = new Float32Array(40);
    let mean = 0;
    for (let j = 0; j < 40; j++) {
      const f = this.fb[j]; let s = 0;
      for (let k = 0; k < this.nb; k++) s += f[k] * this.pow[k];
      m[j] = Math.log(s + this.eps); mean += m[j];
    }
    if (this.a !== null && this.perBin) {
      if (this.ema === null) this.ema = Float64Array.from(m);
      else for (let j = 0; j < 40; j++) this.ema[j] = this.a * this.ema[j] + (1 - this.a) * m[j];
      for (let j = 0; j < 40; j++) m[j] -= this.ema[j];
    } else if (this.a !== null) {
      mean /= 40;
      this.ema = this.ema === null ? mean : this.a * this.ema + (1 - this.a) * mean;
      for (let j = 0; j < 40; j++) m[j] -= this.ema;
    }
    return m;
  }

  // 16 kHz の音を足し、できたフレームを返す [Float32Array(40), ...]
  push(samples) {
    const b = new Float32Array(this.buf.length + samples.length);
    b.set(this.buf); b.set(samples, this.buf.length);
    const out = [];
    let o = 0;
    for (; o + this.nfft <= b.length; o += this.hop) out.push(this.frame(b, o));
    this.buf = b.slice(o);
    return out;
  }
}
