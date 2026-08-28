// ต่อยอด three-pool-vault-test.mjs (ผลดีที่สุด: +15.17% เหรียญ / +15.16% เงิน) — เพิ่มตัวกรอง
// "แนวรับ-แนวต้านจริง" จาก swing high/low ในอดีต (ต่างจากเลขกลมที่เคยทดสอบแล้วไม่เจอนัยสำคัญ)
//
// วิธี: หา swing high/low ด้วยหน้าต่าง ±W ชม. (ยืนยันได้ก็ต่อเมื่อผ่านไปแล้ว W ชม. กันดูอนาคต)
// จัดกลุ่มราคาที่ใกล้กัน (สเกล log กันปัญหาราคาต่างช่วงเวลาต่างกันมาก) นับจำนวนครั้งที่ราคาแตะ
// ระดับนั้น ถ้า >= minTouches ครั้งถือว่าเป็นแนวรับ/แนวต้านที่มีนัยสำคัญ
//
// เพิ่มเงื่อนไข "ซื้อ" ต้องราคาใกล้แนวรับด้วย (นอกเหนือจากไม้แดงยาว)
//
// รันเอง: node scripts/three-pool-support-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const POOL_COUNT = 3;
const POOL_START = START / POOL_COUNT;
const MIN_TICKET = 5;
const SPIKE_ATR_MULT = 1.5;
const SPIKE_FEE_SAFETY = 2.5, SPIKE_RETRACE = 0.20;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;

// พารามิเตอร์แนวรับ-แนวต้าน
const PIVOT_WINDOW_H = 24;   // swing high/low ต้องเป็นจุดสูง/ต่ำสุดในช่วง ±24 ชม.
const LEVEL_TOLERANCE = 0.01; // จัดกลุ่มราคาที่ห่างกันไม่เกิน 1% เป็นแนวเดียวกัน
const MIN_TOUCHES = 3;        // ต้องแตะอย่างน้อย 3 ครั้งถึงนับเป็นแนวที่มีนัยสำคัญ
const NEAR_LEVEL_PCT = 0.02;  // ต้องอยู่ใกล้แนวภายใน 2% ถึงนับว่า "ใกล้แนวรับ"

function atrSeries(c, p = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  const o = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let v = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p;
  o[p] = v;
  for (let i = p + 1; i < c.length; i++) { v = (v * (p - 1) + tr[i]) / p; o[i] = v; }
  return o;
}

// หา swing high/low ทั้งชุด (ไม่มี lookahead ตอนใช้งานจริง เพราะจะ "ยืนยัน" ที่ index+W เท่านั้น)
function findSwingPivots(candles, w) {
  const lows = [], highs = []; // {confirmAt, price}
  for (let i = w; i < candles.length - w; i++) {
    let isLow = true, isHigh = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      if (candles[k].l < candles[i].l) isLow = false;
      if (candles[k].h > candles[i].h) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow) lows.push({ confirmAt: i + w, price: candles[i].l });
    if (isHigh) highs.push({ confirmAt: i + w, price: candles[i].h });
  }
  lows.sort((a, b) => a.confirmAt - b.confirmAt);
  highs.sort((a, b) => a.confirmAt - b.confirmAt);
  return { lows, highs };
}

const bucketKey = (price) => Math.round(Math.log(price) / Math.log(1 + LEVEL_TOLERANCE));

// เช็คว่าราคาใกล้แนวที่มีนัยสำคัญ (จำนวนแตะ >= MIN_TOUCHES) ในแผนที่ที่กำหนดไหม
function nearSignificantLevel(price, levelCounts) {
  const key = bucketKey(price);
  const span = Math.round(Math.log(1 + NEAR_LEVEL_PCT) / Math.log(1 + LEVEL_TOLERANCE));
  for (let k = key - span; k <= key + span; k++) {
    if ((levelCounts.get(k) || 0) >= MIN_TOUCHES) return true;
  }
  return false;
}

function simulate(candles, atr, pivots, opts = {}) {
  const requireSupport = !!opts.requireSupport;
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, buysBlockedByLevel: 0 };

  const supportCounts = new Map(); // จาก swing low
  const resistCounts = new Map();  // จาก swing high (ไว้เผื่ออนาคต ไม่ได้ใช้บล็อกฝั่งขายตอนนี้)
  let lowIdx = 0, highIdx = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;

    // เติมแนวที่เพิ่งยืนยันเข้าแผนที่
    while (lowIdx < pivots.lows.length && pivots.lows[lowIdx].confirmAt <= i) {
      const key = bucketKey(pivots.lows[lowIdx].price);
      supportCounts.set(key, (supportCounts.get(key) || 0) + 1);
      lowIdx++;
    }
    while (highIdx < pivots.highs.length && pivots.highs[highIdx].confirmAt <= i) {
      const key = bucketKey(pivots.highs[highIdx].price);
      resistCounts.set(key, (resistCounts.get(key) || 0) + 1);
      highIdx++;
    }

    if (i % LEARN_EVERY === 0 || !learned) {
      const w = candles.slice(Math.max(0, i - 900), i + 1);
      learned = evaluateIndicators(w, 20, 60) || learned;
    }
    const win = candles.slice(Math.max(0, i - SCORE_WINDOW), i + 1);
    const an = scoreMarket(price, win, computeReturns(win), learned);
    const score = an.composite;
    if (!Number.isFinite(score)) continue;

    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    const isGreenLong = isSpike && body > 0;
    const isRedLong = isSpike && body < 0 && score >= THRESHOLDS.weakBuy;
    const nearSupport = !requireSupport || nearSignificantLevel(price, supportCounts);

    for (const pool of pools) {
      if (isGreenLong && pool.lot) {
        const proceeds = pool.lot.qty * price * (1 - FEE);
        const cost = pool.lot.qty * pool.lot.price * (1 + FEE);
        const profitUsd = proceeds - cost;
        if (profitUsd > 0) {
          pool.cash += cost;
          vaultBtc += profitUsd / price;
          pool.lot = null;
          st.sells++;
        }
      }
      if (isRedLong && !pool.lot && pool.cash >= MIN_TICKET) {
        if (!nearSupport) { st.buysBlockedByLevel++; continue; }
        const amt = pool.cash;
        const q = amt / price;
        pool.cash -= amt * (1 + FEE);
        pool.lot = { qty: q, price };
        st.buys++;
      }
    }
  }

  const last = candles[candles.length - 1].c;
  const cash = pools.reduce((s, p) => s + p.cash, 0);
  const tradingBtc = pools.reduce((s, p) => s + (p.lot ? p.lot.qty : 0), 0);
  const totalBtc = tradingBtc + vaultBtc;
  const holdCoins = START / candles[WARMUP].c;
  const equity = cash + totalBtc * last;
  const holdEquity = holdCoins * last;
  return {
    ...st, cash, tradingBtc, vaultBtc, totalBtc, equity, holdEquity,
    coinsVsHold: (totalBtc / holdCoins - 1) * 100,
    equityVsHold: (equity / holdEquity - 1) * 100,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START} (แบ่ง ${POOL_COUNT} ก้อน $${POOL_START} ต่อก้อน)`);
console.log(`กำลังหา swing high/low (หน้าต่าง ±${PIVOT_WINDOW_H}ชม.)...`);
const pivots = findSwingPivots(all, PIVOT_WINDOW_H);
console.log(`พบ swing low ${pivots.lows.length} จุด | swing high ${pivots.highs.length} จุด\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.coinsVsHold));
  const eq = stats(runs.map((r) => r.equityVsHold));
  const buys = stats(runs.map((r) => r.buys));
  const blocked = stats(runs.map((r) => r.buysBlockedByLevel));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อจริง ${buys.mean.toFixed(1)} ครั้ง | ถูกบล็อกเพราะไม่ใกล้แนวรับ ${blocked.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี | เกณฑ์: แนวรับต้องแตะ >=${MIN_TOUCHES} ครั้ง, ใกล้ภายใน ${(NEAR_LEVEL_PCT * 100).toFixed(0)}%\n`);

const noFilter = [], withFilter = [];
for (let t = 0; t < TRIALS; t++) {
  noFilter.push(simulate(all, atr, pivots, { requireSupport: false }));
  withFilter.push(simulate(all, atr, pivots, { requireSupport: true }));
}

summarize("ไม่กรองแนวรับ (ของเดิม)", noFilter);
summarize("ต้องใกล้แนวรับจริงถึงซื้อ", withFilter);
