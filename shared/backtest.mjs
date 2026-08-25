// เรียนรู้จากข้อมูลเก่า — วัดว่า "อินดิเคเตอร์แต่ละตัวเคยทำนายถูกจริงแค่ไหน" บนแท่งเทียนย้อนหลัง
// แล้วเอาผลที่วัดได้ไปปรับน้ำหนักการตัดสินใจ แทนที่จะใช้น้ำหนักที่ตั้งไว้ตายตัวจากการเดา
//
// วิธี (walk-forward ไม่มองอนาคต): ที่แท่งเวลา i ใช้ข้อมูลถึงแท่ง i เท่านั้นคำนวณสัญญาณ
// แล้วดูว่าอีก H แท่งข้างหน้าราคาไปทางเดียวกับที่สัญญาณบอกไหม -> ได้อัตราการทายถูก (hit rate)
// และค่า edge (ความสัมพันธ์ระหว่างความแรงของสัญญาณกับผลตอบแทนที่เกิดขึ้นจริง)
//
// ข้อจำกัดที่ต้องรู้: นี่คือการวัดผลบนอดีต ไม่ได้แปลว่าอนาคตจะเป็นแบบเดียวกัน
// ใช้เพื่อ "ลดน้ำหนักตัวที่พิสูจน์แล้วว่าไม่ช่วย" มากกว่าจะเชื่อว่ามันทำนายอนาคตได้แม่นยำ

import { computeRSI, computeEMA, computeBollinger, computeMACD } from "./signals.mjs";
import { computePercentB, computeROC, computeRange } from "./strategy.mjs";

// คะแนนดิบของแต่ละเทคนิคที่ "คำนวณเร็ว" (ไม่รวม Monte Carlo ที่หนักเกินจะรันย้อนหลังทุกแท่ง)
// สูตรตรงกับใน strategy.mjs เพื่อให้สิ่งที่วัดย้อนหลังคือสิ่งเดียวกับที่ใช้ตัดสินใจจริง
export function cheapScores(price, window) {
  const out = {};
  const emaFast = computeEMA(window, 9);
  const emaSlow = computeEMA(window, 21);
  if (emaFast != null && emaSlow != null && emaSlow !== 0) {
    const gapPct = (emaFast - emaSlow) / emaSlow * 100;
    out.trend = Math.max(-100, Math.min(100, gapPct * 60));
  }
  const macd = computeMACD(window, 12, 26, 9);
  if (macd && price) {
    out.macd = Math.max(-100, Math.min(100, macd.histogram / price * 100 * 400));
  }
  const rsi = computeRSI(window, 14);
  if (rsi != null) out.rsi = Math.max(-100, Math.min(100, (50 - rsi) * 3));

  const bb = computeBollinger(window, 20, 2);
  const pctB = computePercentB(price, bb);
  if (pctB != null) out.meanRevert = Math.max(-100, Math.min(100, (0.5 - pctB) * 200));

  const roc = computeROC(window, 10);
  if (roc != null) out.momentum = Math.max(-100, Math.min(100, roc * 25));

  const range = computeRange(window, 60);
  if (range) out.rangePos = Math.max(-100, Math.min(100, (0.5 - range.position) * 160));

  return out;
}

// ประเมินอินดิเคเตอร์ทุกตัวบนข้อมูลย้อนหลัง คืน hit rate + edge + ตัวคูณน้ำหนักที่แนะนำ
export function evaluateIndicators(candles, horizon = 20, warmup = 60) {
  if (!candles || candles.length < warmup + horizon + 20) return null;

  const stats = {};
  const lastIdx = candles.length - horizon - 1;
  let samples = 0;

  for (let i = warmup; i <= lastIdx; i++) {
    const window = candles.slice(0, i + 1);
    const price = window[window.length - 1].c;
    if (!price) continue;
    const fwdRet = (candles[i + horizon].c / price - 1) * 100; // % ที่เกิดขึ้นจริงในอนาคต
    if (!isFinite(fwdRet)) continue;
    const scores = cheapScores(price, window);
    samples++;
    for (const key of Object.keys(scores)) {
      const s = scores[key];
      if (!isFinite(s)) continue;
      if (!stats[key]) stats[key] = { n: 0, hits: 0, sumEdge: 0, sumAbs: 0 };
      const st = stats[key];
      st.n++;
      // นับว่าทายถูกเมื่อทิศของสัญญาณตรงกับทิศที่ราคาไปจริง (ข้ามกรณีสัญญาณ ~0 ที่ไม่ได้บอกทิศ)
      if (Math.abs(s) > 3) {
        if ((s > 0 && fwdRet > 0) || (s < 0 && fwdRet < 0)) st.hits++;
        st.sumAbs++;
      }
      st.sumEdge += (s / 100) * fwdRet; // สัญญาณแรง+ไปถูกทาง = edge บวกเยอะ
    }
  }

  const result = {};
  for (const key of Object.keys(stats)) {
    const st = stats[key];
    const hitRate = st.sumAbs > 0 ? st.hits / st.sumAbs : null;
    const edge = st.n > 0 ? st.sumEdge / st.n : 0;
    // ตัวคูณน้ำหนัก: ทายถูกเกิน 50% = เพิ่มน้ำหนัก, ต่ำกว่า = ลดน้ำหนัก
    // จำกัดช่วง 0.4-1.6 เพื่อไม่ให้ผลจากอดีตช่วงสั้นๆ เหวี่ยงระบบมากเกินไป
    let mult = 1;
    if (hitRate != null) mult = Math.max(0.4, Math.min(1.6, 1 + (hitRate - 0.5) * 3));
    result[key] = {
      hitRate: hitRate != null ? Math.round(hitRate * 1000) / 10 : null, // เป็น %
      edge: Math.round(edge * 1000) / 1000,
      samples: st.sumAbs,
      weightMultiplier: Math.round(mult * 100) / 100,
    };
  }
  return { horizon, samples, indicators: result };
}

// สรุปผลการเรียนรู้เป็นข้อความไทยสั้นๆ สำหรับใส่ใน log ให้แอดมินอ่าน
export function describeLearning(learned) {
  if (!learned || !learned.indicators) return "ยังไม่มีข้อมูลย้อนหลังพอจะประเมิน";
  const rows = Object.keys(learned.indicators).map((k) => {
    const v = learned.indicators[k];
    return `${k} ทายถูก ${v.hitRate != null ? v.hitRate + "%" : "n/a"} (น้ำหนัก x${v.weightMultiplier})`;
  });
  return `เรียนรู้จาก ${learned.samples} จุดย้อนหลัง มองไป ${learned.horizon} แท่ง: ${rows.join(", ")}`;
}
