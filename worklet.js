// マイクの音を 16 kHz にして、160 ms（2560 点）ずつ本体へ送る。
// AudioContext が 16 kHz で動いていれば間引きは要らない。そうでなければ（Firefox など）ここで落とす。
class Tap extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const N = (opt && opt.processorOptions && opt.processorOptions.n) || 2560;   // 1 回に送る点数（モデルの 1 回ぶん。40 ms なら 640）
    this.ratio = sampleRate / 16000;          // 1 なら素通し
    this.N = N; this.buf = new Float32Array(N); this.n = 0;
    this.pos = 0; this.acc = 0; this.cnt = 0;   // 間引き用（区間の平均 = 簡単な低域通過）
    this.level = 0; this.lv = 0;
  }

  out(x) {
    this.buf[this.n++] = x;
    this.lv = Math.max(this.lv, Math.abs(x));
    if (this.n === this.buf.length) {
      this.port.postMessage({ samples: this.buf, peak: this.lv }, [this.buf.buffer]);
      this.buf = new Float32Array(this.N); this.n = 0; this.lv = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) { for (let i = 0; i < ch.length; i++) this.out(ch[i]); return true; }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) { this.out(this.acc / this.cnt); this.pos -= this.ratio; this.acc = 0; this.cnt = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);
