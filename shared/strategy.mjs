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
const WEIGHTS = {
  trend: 1.4,       // EMA9 vs EMA21
  macd: 1.2,        // MACD histogram
  rsi: 1.1,         // RSI 14
  meanRevert: 1.0,  // Bollinger %B
  forecast: 0.9,    // Monte Carlo probUp
  momentum: 0.8,    // ROC
  rangePos: 0.7,    // ตำแหน่งในกรอบราคา
};

export function scoreMarket(price, candles, returns) {
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
      key: "trend", weight: WEIGHTS.trend, score: s,
      text: `EMA9 ${sig.trendUp ? "อยู่เหนือ" : "อยู่ใต้"} EMA21 (ห่างกัน ${gapPct.toFixed(3)}%) — แนวโน้มระยะสั้นเป็น${sig.trendUp ? "ขาขึ้น" : "ขาลง"}`,
    });
  }

  if (sig.macd) {
    const norm = price ? sig.macd.histogram / price * 100 : 0;
    const s = Math.max(-100, Math.min(100, norm * 400));
    parts.push({
      key: "macd", weight: WEIGHTS.macd, score: s,
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
      key: "rsi", weight: WEIGHTS.rsi, score: s,
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
      key: "meanRevert", weight: WEIGHTS.meanRevert, score: s,
      text: `Bollinger %B = ${pctB.toFixed(2)} — ราคา${where}`,
    });
  }

  if (sig.forecast) {
    const s = Math.max(-100, Math.min(100, (sig.forecast.probUp - 0.5) * 300));
    parts.push({
      key: "forecast", weight: WEIGHTS.forecast, score: s,
      text: `Monte Carlo ประเมินโอกาสราคาขึ้น ${Math.round(sig.forecast.probUp * 100)}% ใน 20 แท่งข้างหน้า`,
    });
  }

  if (roc != null) {
    const s = Math.max(-100, Math.min(100, roc * 25));
    parts.push({
      key: "momentum", weight: WEIGHTS.momentum, score: s,
      text: `ราคาเปลี่ยน ${roc >= 0 ? "+" : ""}${roc.toFixed(2)}% ใน 10 แท่งล่าสุด (โมเมนตัม)`,
    });
  }

  if (range) {
    // อยู่ใกล้ฐานของกรอบ = น่าซื้อ, ใกล้ยอด = ระวัง
    const s = Math.max(-100, Math.min(100, (0.5 - range.position) * 160));
    parts.push({
      key: "rangePos", weight: WEIGHTS.rangePos, score: s,
      text: `ราคาอยู่ที่ ${Math.round(range.position * 100)}% ของกรอบ 60 แท่ง (ต่ำสุด ${range.low.toFixed(0)} / สูงสุด ${range.high.toFixed(0)})`,
    });
  }

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0) || 1;
  const composite = parts.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight;

  // ความผันผวนเทียบราคา ใช้ปรับขนาดไม้: ผันผวนสูง = ลงเงินน้อยลง
  const atrPct = atr && price ? atr / price * 100 : null;

  return { signal: sig, parts, composite, atr, atrPct, pctB, roc, range };
}

// ---------- เกณฑ์ตัดสินใจ ----------
export const THRESHOLDS = {
  strongBuy: 25,    // คะแนนรวม >= นี้ = สัญญาณซื้อชัดเจน
  weakBuy: 8,       // >= นี้ = ซื้อได้แบบระมัดระวัง (ไม้เล็ก)
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
