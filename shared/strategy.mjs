// เครื่องตัดสินใจซื้อขายอัตโนมัติ 100% — ให้คะแนนถ่วงน้ำหนักจากหลายเทคนิค แล้วสรุปเป็นคำสั่งพร้อม "เหตุผล" ที่อ่านได้
//
// เป้าหมายคือกำไรเป็น "จำนวน BTC" ทั้งระยะสั้นและระยะยาว จึงแบ่งเงินเป็น 2 ขา (sleeve):
//   core  = ขาสะสมระยะยาว ทยอยซื้อเก็บ ไม่ขายออกอัตโนมัติเลย -> จำนวน BTC โตขึ้นเรื่อยๆ ตามเวลา
//   swing = ขาเทรดสั้น ขายตอนราคาสูง แล้วบังคับซื้อคืนที่ราคาต่ำพอจะได้เหรียญกลับมามากกว่าเดิม
//
// ทุกการตัดสินใจ (รวมถึง "ไม่ทำอะไร") จะคืนค่า reasons[] ที่อธิบายเป็นภาษาไทยว่าทำไม
// เพื่อให้แอดมินย้อนอ่านได้ว่าระบบคิดยังไง และเอาไปปรับปรุงกลยุทธ์ต่อได้

import { computeSignal, stdev } from "./signals.mjs";

// ---------- อินดิเคเตอร์เพิ่มเติมที่ใช้เฉพาะการตัดสินใจ ----------

// ATR (Average True Range) — วัดความผันผวนจริงต่อแท่ง ใช้กำหนดขนาดไม้และระยะ stop
export function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// %B ของ Bollinger — บอกตำแหน่งราคาในกรอบ (0 = ชนกรอบล่าง, 1 = ชนกรอบบน)
export function computePercentB(price, bb) {
  if (!bb || bb.upper === bb.lower) return null;
  return (price - bb.lower) / (bb.upper - bb.lower);
}

// Rate of Change — โมเมนตัมดิบ เทียบราคาปัจจุบันกับ n แท่งก่อน
export function computeROC(candles, period = 10) {
  if (candles.length < period + 1) return null;
  const prev = candles[candles.length - 1 - period].c;
  if (!prev) return null;
  return (candles[candles.length - 1].c / prev - 1) * 100;
}

// แนวรับ/แนวต้านจากจุดสูงสุด-ต่ำสุดของ n แท่งล่าสุด + ตำแหน่งราคาปัจจุบันในช่วงนั้น
export function computeRange(candles, period = 60) {
  if (candles.length < 10) return null;
  const slice = candles.slice(-period);
  const high = Math.max(...slice.map((c) => c.h));
  const low = Math.min(...slice.map((c) => c.l));
  if (high === low) return null;
  const last = slice[slice.length - 1].c;
  return { high, low, position: (last - low) / (high - low) };
}

// ---------- เครื่องให้คะแนน ----------
// แต่ละเทคนิคให้คะแนน -100..+100 (บวก = น่าซื้อ) พร้อมข้อความอธิบาย แล้วถ่วงน้ำหนักรวมกัน
// น้ำหนักตั้งจากลักษณะการใช้งานจริง: เทรนด์/โมเมนตัมน้ำหนักสูงกว่าเพราะเชื่อถือได้กว่าในตลาดที่มีทิศทาง
// ---------- อินดิเคเตอร์ชุดเพิ่มเติม (เพิ่มความมั่นใจ / ลดการพึ่งตัวใดตัวหนึ่ง) ----------

// Stochastic %K — ราคาปิดอยู่ตรงไหนของกรอบ high/low ช่วงล่าสุด (0-100) นิยมใช้จับ overbought/oversold
export function computeStochastic(candles, period = 14) {
  if (!candles || candles.length < period) return null;
  const s = candles.slice(-period);
  const hi = Math.max(...s.map((c) => c.h));
  const lo = Math.min(...s.map((c) => c.l));
  if (hi === lo) return 50;
  return ((candles[candles.length - 1].c - lo) / (hi - lo)) * 100;
}

// Williams %R — คล้าย Stochastic แต่กลับด้าน (-100 ถึง 0) ไวต่อการกลับตัวที่ปลายกรอบ
export function computeWilliamsR(candles, period = 14) {
  const k = computeStochastic(candles, period);
  return k == null ? null : k - 100;
}

// CCI — ราคาห่างจากค่าเฉลี่ยกี่เท่าของค่าเบี่ยงเบนปกติ ใช้จับภาวะราคาวิ่งไกลเกินจนน่าจะเด้งกลับ
export function computeCCI(candles, period = 20) {
  if (!candles || candles.length < period) return null;
  const s = candles.slice(-period);
  const tp = s.map((c) => (c.h + c.l + c.c) / 3);
  const sma = tp.reduce((a, b) => a + b, 0) / period;
  const md = tp.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
  if (md === 0) return 0;
  return (tp[tp.length - 1] - sma) / (0.015 * md);
}

// DMI / ADX — แยก "ทิศ" (+DI vs -DI) ออกจาก "ความแรงของเทรนด์" (ADX)
// ADX ต่ำ = ตลาดออกข้าง (สัญญาณเทรนด์เชื่อไม่ค่อยได้), ADX สูง = เทรนด์จริง
export function computeDMI(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.h - p.h, down = p.l - c.l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  // Wilder smoothing
  const smooth = (arr) => {
    let v = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [v];
    for (let i = period; i < arr.length; i++) { v = v - v / period + arr[i]; out.push(v); }
    return out;
  };
  const sTR = smooth(tr), sP = smooth(plusDM), sM = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < sTR.length; i++) {
    if (!sTR[i]) { dx.push(0); continue; }
    const pdi = (sP[i] / sTR[i]) * 100, mdi = (sM[i] / sTR[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
  }
  if (dx.length < period) return null;
  const adx = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
  const last = sTR.length - 1;
  const plusDI = sTR[last] ? (sP[last] / sTR[last]) * 100 : 0;
  const minusDI = sTR[last] ? (sM[last] / sTR[last]) * 100 : 0;
  return { plusDI, minusDI, adx };
}

// MFI — RSI ที่ถ่วงด้วยปริมาณซื้อขาย ใช้ข้อมูล "วอลุ่ม" ซึ่งเป็นข้อมูลคนละชุดกับราคาล้วนๆ
export function computeMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  if (candles.some((c) => c.v == null)) return null; // ไม่มีวอลุ่ม ใช้ไม่ได้
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const ptp = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const flow = tp * candles[i].v;
    if (tp > ptp) pos += flow; else if (tp < ptp) neg += flow;
  }
  if (neg === 0) return pos === 0 ? 50 : 100;
  return 100 - 100 / (1 + pos / neg);
}

// OBV slope — วอลุ่มสะสมตามทิศราคา ชันขึ้น = แรงซื้อสะสมจริง (ยืนยันราคาด้วยวอลุ่ม)
export function computeOBVSlope(candles, period = 20) {
  if (!candles || candles.length < period + 1) return null;
  if (candles.some((c) => c.v == null)) return null;
  let obv = 0;
  const series = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].c > candles[i - 1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i - 1].c) obv -= candles[i].v;
    series.push(obv);
  }
  const s = series.slice(-period);
  const first = s[0], last = s[s.length - 1];
  const scale = Math.max(...s.map(Math.abs)) || 1;
  return ((last - first) / scale) * 100; // -100..100 โดยประมาณ
}

const WEIGHTS = {
  trend: 1.4,       // EMA9 vs EMA21
  macd: 1.2,        // MACD histogram
  rsi: 1.1,         // RSI 14
  meanRevert: 1.0,  // Bollinger %B
  forecast: 0.9,    // Monte Carlo probUp
  momentum: 0.8,    // ROC
  rangePos: 0.7,    // ตำแหน่งในกรอบราคา
  stoch: 1.0,       // Stochastic %K
  williams: 0.8,    // Williams %R
  cci: 0.9,         // CCI
  dmi: 1.1,         // +DI/-DI ถ่วงด้วยความแรงเทรนด์ (ADX)
  mfi: 1.0,         // Money Flow Index (ใช้วอลุ่ม)
  obv: 0.8,         // OBV slope (ใช้วอลุ่ม)
};

// learned = ผลจาก evaluateIndicators() (shared/backtest.mjs) — ถ้าส่งมาจะปรับน้ำหนักตามที่วัดได้จริงจากอดีต
export function scoreMarket(price, candles, returns, learned) {
  const lw = (learned && learned.indicators) || null;
  const wOf = (key) => WEIGHTS[key] * (lw && lw[key] ? lw[key].weightMultiplier : 1);
  const sig = computeSignal(price, candles, returns);
  const atr = computeATR(candles, 14);
  const pctB = computePercentB(price, sig.bb);
  const roc = computeROC(candles, 10);
  const range = computeRange(candles, 60);

  const parts = [];

  if (sig.trendUp != null) {
    const gapPct = sig.emaSlow ? (sig.emaFast - sig.emaSlow) / sig.emaSlow * 100 : 0;
    const s = Math.max(-100, Math.min(100, gapPct * 60));
    parts.push({
      key: "trend", weight: wOf("trend"), score: s,
      text: `EMA9 ${sig.trendUp ? "อยู่เหนือ" : "อยู่ใต้"} EMA21 (ห่างกัน ${gapPct.toFixed(3)}%) — แนวโน้มระยะสั้นเป็น${sig.trendUp ? "ขาขึ้น" : "ขาลง"}`,
    });
  }

  if (sig.macd) {
    const norm = price ? sig.macd.histogram / price * 100 : 0;
    const s = Math.max(-100, Math.min(100, norm * 400));
    parts.push({
      key: "macd", weight: wOf("macd"), score: s,
      text: `MACD histogram ${sig.macd.histogram.toFixed(2)} (${sig.macd.histogram >= 0 ? "บวก" : "ลบ"}) — โมเมนตัมเชิงแนวโน้ม${sig.macd.histogram >= 0 ? "หนุนขาขึ้น" : "กดดันขาลง"}`,
    });
  }

  if (sig.rsi != null) {
    // RSI ใช้แบบ mean-reversion: ต่ำ = น่าซื้อ, สูง = น่าขาย โดยกลางที่ 50
    const s = Math.max(-100, Math.min(100, (50 - sig.rsi) * 3));
    let zone = "โซนกลาง";
    if (sig.rsi < 30) zone = "โซนขายมากเกินไป (oversold)";
    else if (sig.rsi > 70) zone = "โซนซื้อมากเกินไป (overbought)";
    parts.push({
      key: "rsi", weight: wOf("rsi"), score: s,
      text: `RSI(14) = ${sig.rsi.toFixed(1)} อยู่ใน${zone}`,
    });
  }

  if (pctB != null) {
    // %B 0 = ชนกรอบล่าง (น่าซื้อ), 1 = ชนกรอบบน (น่าขาย)
    const s = Math.max(-100, Math.min(100, (0.5 - pctB) * 200));
    let where = "กลางกรอบ";
    if (pctB <= 0.1) where = "ชนกรอบล่าง (ราคาถูกผิดปกติเทียบสถิติ)";
    else if (pctB >= 0.9) where = "ชนกรอบบน (ราคาแพงผิดปกติเทียบสถิติ)";
    parts.push({
      key: "meanRevert", weight: wOf("meanRevert"), score: s,
      text: `Bollinger %B = ${pctB.toFixed(2)} — ราคา${where}`,
    });
  }

  if (sig.forecast) {
    const s = Math.max(-100, Math.min(100, (sig.forecast.probUp - 0.5) * 300));
    parts.push({
      key: "forecast", weight: wOf("forecast"), score: s,
      text: `Monte Carlo ประเมินโอกาสราคาขึ้น ${Math.round(sig.forecast.probUp * 100)}% ใน 20 แท่งข้างหน้า`,
    });
  }

  if (roc != null) {
    const s = Math.max(-100, Math.min(100, roc * 25));
    parts.push({
      key: "momentum", weight: wOf("momentum"), score: s,
      text: `ราคาเปลี่ยน ${roc >= 0 ? "+" : ""}${roc.toFixed(2)}% ใน 10 แท่งล่าสุด (โมเมนตัม)`,
    });
  }

  if (range) {
    // อยู่ใกล้ฐานของกรอบ = น่าซื้อ, ใกล้ยอด = ระวัง
    const s = Math.max(-100, Math.min(100, (0.5 - range.position) * 160));
    parts.push({
      key: "rangePos", weight: wOf("rangePos"), score: s,
      text: `ราคาอยู่ที่ ${Math.round(range.position * 100)}% ของกรอบ 60 แท่ง (ต่ำสุด ${range.low.toFixed(0)} / สูงสุด ${range.high.toFixed(0)})`,
    });
  }

  // ---------- อินดิเคเตอร์ชุดเพิ่ม ----------
  const stoch = computeStochastic(candles, 14);
  if (stoch != null) {
    const s = Math.max(-100, Math.min(100, (50 - stoch) * 2.4));
    parts.push({ key: "stoch", weight: wOf("stoch"), score: s,
      text: `Stochastic %K = ${stoch.toFixed(1)} (${stoch > 80 ? "ซื้อมากไป" : stoch < 20 ? "ขายมากไป" : "โซนกลาง"})` });
  }
  const willr = computeWilliamsR(candles, 14);
  if (willr != null) {
    const s = Math.max(-100, Math.min(100, (-50 - willr) * 2.4));
    parts.push({ key: "williams", weight: wOf("williams"), score: s,
      text: `Williams %R = ${willr.toFixed(1)} (${willr > -20 ? "ซื้อมากไป" : willr < -80 ? "ขายมากไป" : "โซนกลาง"})` });
  }
  const cci = computeCCI(candles, 20);
  if (cci != null) {
    const s = Math.max(-100, Math.min(100, -cci / 2));
    parts.push({ key: "cci", weight: wOf("cci"), score: s,
      text: `CCI(20) = ${cci.toFixed(0)} (${cci > 100 ? "ราคาวิ่งสูงเกินปกติ" : cci < -100 ? "ราคาต่ำเกินปกติ" : "อยู่ในกรอบปกติ"})` });
  }
  const dmi = computeDMI(candles, 14);
  if (dmi) {
    // ทิศจาก +DI/-DI แต่ถ่วงด้วย ADX: ตลาดออกข้าง (ADX ต่ำ) ให้เชื่อสัญญาณเทรนด์น้อยลง
    const dirRaw = Math.max(-100, Math.min(100, (dmi.plusDI - dmi.minusDI) * 4));
    const strength = Math.min(1, dmi.adx / 40);
    parts.push({ key: "dmi", weight: wOf("dmi"), score: dirRaw * strength,
      text: `DMI: +DI ${dmi.plusDI.toFixed(1)} / -DI ${dmi.minusDI.toFixed(1)}, ADX ${dmi.adx.toFixed(1)} (${dmi.adx < 20 ? "เทรนด์อ่อน ตลาดออกข้าง" : dmi.adx > 40 ? "เทรนด์แรง" : "เทรนด์ปานกลาง"})` });
  }
  const mfi = computeMFI(candles, 14);
  if (mfi != null) {
    const s = Math.max(-100, Math.min(100, (50 - mfi) * 3));
    parts.push({ key: "mfi", weight: wOf("mfi"), score: s,
      text: `MFI(14) = ${mfi.toFixed(1)} — เงินไหลเข้า/ออกถ่วงด้วยวอลุ่ม (${mfi > 80 ? "ซื้อมากไป" : mfi < 20 ? "ขายมากไป" : "ปกติ"})` });
  }
  const obv = computeOBVSlope(candles, 20);
  if (obv != null) {
    parts.push({ key: "obv", weight: wOf("obv"), score: Math.max(-100, Math.min(100, obv)),
      text: `OBV slope = ${obv.toFixed(0)} — วอลุ่มสะสม${obv > 0 ? "ไหลเข้า" : "ไหลออก"}` });
  }

  // ใช้ผลรวมของ "ค่าสัมบูรณ์" ของน้ำหนัก เพราะน้ำหนักติดลบได้แล้ว (ตัวที่ทายผิดประจำจะถูกกลับทิศ)
  // ถ้าใช้ผลรวมปกติ ตัวหารอาจเข้าใกล้ศูนย์หรือติดลบ ทำให้คะแนนรวมเพี้ยนทั้งระบบ
  const totalWeight = parts.reduce((a, p) => a + Math.abs(p.weight), 0) || 1;
  const composite = parts.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight;

  // ความผันผวนเทียบราคา ใช้ปรับขนาดไม้: ผันผวนสูง = ลงเงินน้อยลง
  const atrPct = atr && price ? atr / price * 100 : null;

  return { signal: sig, parts, composite, atr, atrPct, pctB, roc, range };
}

// ---------- เกณฑ์ตัดสินใจ ----------
export const THRESHOLDS = {
  // เกณฑ์ซื้อเดิมคือ 8 ซึ่งบนสเกล -100..100 แทบจะเป็น "กลางๆ" ระบบจึงซื้อได้เกือบตลอดเวลา
  // รวมถึงตอนกราฟกำลังวิ่งขึ้น (ซึ่งไม่ใช่จังหวะเข้า) ทดสอบย้อนหลังหลายช่วงแล้วเลือก 22
  // เพราะเป็นค่าเดียวที่ดีกว่า 8 ทั้งบนไทม์เฟรม 4 ชม. และ 1 ชม. พร้อมลดความถี่การซื้อลงชัดเจน
  strongBuy: 45,    // คะแนนรวม >= นี้ = สัญญาณซื้อชัดเจน
  weakBuy: 22,      // >= นี้ = ซื้อได้แบบระมัดระวัง (ไม้เล็ก)
  sellBias: -20,    // <= นี้ = ตลาดเอนขาลง พิจารณาขายทำกำไรเร็วขึ้น
  strongSell: -45,  // <= นี้ = ขาลงชัดเจน
};

// แปลคะแนนรวมเป็นคำอธิบายสั้นๆ
export function describeScore(score) {
  if (score >= THRESHOLDS.strongBuy) return "สัญญาณซื้อชัดเจน";
  if (score >= THRESHOLDS.weakBuy) return "เอนไปทางซื้อ";
  if (score <= THRESHOLDS.strongSell) return "ขาลงชัดเจน";
  if (score <= THRESHOLDS.sellBias) return "เอนไปทางขาลง";
  return "กลางๆ ไม่ชัดเจน";
}

// ขนาดไม้ตามความมั่นใจ + ความผันผวน (Kelly แบบง่าย): มั่นใจมาก/ผันผวนต่ำ = ลงหนักขึ้น
export function positionFraction(score, atrPct) {
  const conf = Math.max(0, Math.min(1, (score - THRESHOLDS.weakBuy) / (100 - THRESHOLDS.weakBuy)));
  let frac = 0.15 + conf * 0.45; // 15%-60% ของเงินสดที่จัดสรรให้ swing
  if (atrPct != null && atrPct > 0) {
    // ผันผวนสูงกว่า 1%/แท่ง เริ่มหั่นขนาดไม้ลง
    const volAdj = Math.min(1, 1.0 / Math.max(0.35, atrPct));
    frac *= volAdj;
  }
  return Math.max(0.08, Math.min(0.6, frac));
}
