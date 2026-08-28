// ต่อยอดแนวรับ-แนวต้านบนโครง 3-pool ที่ชนะจริง (+15.17% ถึง +15.63%) ตามที่ขอ — ไม่ใช้เป็นตัวบล็อก
// (ที่เคยพังตอนทดสอบเป็น hard filter) แต่ใช้ปรับ "สัดส่วนเงินที่ลงต่อไม้" และ "สัดส่วนที่ขาย" แทน:
//   - ไม้แดงยาวใกล้แนวรับ -> ก้อนนั้นลงทุนเต็ม 100% ของ $100 | ไม่ใกล้ -> ลงแค่ 60%
//   - ไม้เขียวยาว+กำไรใกล้แนวต้าน -> ขายเต็ม 100% ของไม้ | ไม่ใกล้ -> ขายแค่ 60% (เหลือไม้เปิดต่อ)
//   - เก็บ floor: BTC ที่ถือในขาเทรดรวมทุกก้อน ต้องไม่ต่ำกว่า 25% ของยอดสูงสุดที่เคยถือ
//
// รันเอง: node scripts/three-pool-sr-sizing-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const POOL_COUNT = 3;
const POOL_CAP = START / POOL_COUNT; // เพดานเงินต่อก้อน $100 (คงที่เท่าเดิม)
const MIN_TICKET = 5;
const SPIKE_ATR_MULT = 1.5;
const SPIKE_FEE_SAFETY = 2.5, SPIKE_RETRACE = 0.20;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;

const PIVOT_WINDOW_H = 24;
const LEVEL_TOLERANCE = 0.01;
const MIN_TOUCHES = 3;
const NEAR_LEVEL_PCT = 0.02;

const BUY_FRAC_NEAR_SUPPORT = 1.00, BUY_FRAC_BASE = 0.60; // % ของ $100 ที่ลงทุนต่อไม้
const SELL_FRAC_NEAR_RESIST = 1.00, SELL_FRAC_BASE = 0.60; // % ของไม้ที่ขายออก
const KEEP_FLOOR_PCT = 0.25; // BTC รวมทุกก้อนต้องไม่ต่ำกว่า 25% ของยอดสูงสุดที่เคยถือ

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
function findSwingPivots(candles, w) {
  const lows = [], highs = [];
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
function nearSignificantLevel(price, levelCounts) {
  const key = bucketKey(price);
  const span = Math.round(Math.log(1 + NEAR_LEVEL_PCT) / Math.log(1 + LEVEL_TOLERANCE));
  for (let k = key - span; k <= key + span; k++) if ((levelCounts.get(k) || 0) >= MIN_TOUCHES) return true;
  return false;
}

// mode: "flat" (ของเดิม all-in $100 เสมอ ขายเต็มเสมอ) | "srSizing" (ปรับตามแนวรับ-ต้าน + floor 25%)
function simulate(candles, atr, pivots, mode) {
  // pool.cash = เงินสดว่างของก้อนนี้ (สูงสุด $100), pool.lot = {qty, price} | null
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_CAP, lot: null }));
  let vaultBtc = 0;
  let peakTradingBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, partialSells: 0, partialBuys: 0 };
  const supportCounts = new Map(), resistCounts = new Map();
  let lowIdx = 0, highIdx = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;

    while (lowIdx < pivots.lows.length && pivots.lows[lowIdx].confirmAt <= i) {
      const k = bucketKey(pivots.lows[lowIdx].price);
      supportCounts.set(k, (supportCounts.get(k) || 0) + 1);
      lowIdx++;
    }
    while (highIdx < pivots.highs.length && pivots.highs[highIdx].confirmAt <= i) {
      const k = bucketKey(pivots.highs[highIdx].price);
      resistCounts.set(k, (resistCounts.get(k) || 0) + 1);
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
    const nearSupport = mode === "srSizing" && nearSignificantLevel(price, supportCounts);
    const nearResist = mode === "srSizing" && nearSignificantLevel(price, resistCounts);

    const tradingBtcNow = pools.reduce((s, p) => s + (p.lot ? p.lot.qty : 0), 0);
    peakTradingBtc = Math.max(peakTradingBtc, tradingBtcNow);
    const floor = mode === "srSizing" ? peakTradingBtc * KEEP_FLOOR_PCT : 0;

    for (const pool of pools) {
      // ---- ขาย ----
      if (isGreenLong && pool.lot) {
        const proceeds = pool.lot.qty * price * (1 - FEE);
        const cost = pool.lot.qty * pool.lot.price * (1 + FEE);
        const profitUsd = proceeds - cost;
        if (profitUsd > 0) {
          const sellFrac = mode === "srSizing" ? (nearResist ? SELL_FRAC_NEAR_RESIST : SELL_FRAC_BASE) : 1.0;
          let sellQty = pool.lot.qty * sellFrac;
          // เช็ค floor รวมทุกก้อน ก่อนขายจริง (ประมาณคร่าวๆ ต่อก้อน พอเป็น guard)
          const currentTotal = pools.reduce((s, p) => s + (p.lot ? p.lot.qty : 0), 0);
          if (currentTotal - sellQty < floor) sellQty = Math.max(0, currentTotal - floor);
          if (sellQty * price >= MIN_TICKET && sellQty > 1e-9) {
            const sellProceeds = sellQty * price * (1 - FEE);
            const sellCost = sellQty * pool.lot.price * (1 + FEE);
            const sellProfit = sellProceeds - sellCost;
            pool.cash += sellCost;
            vaultBtc += Math.max(0, sellProfit) / price;
            const remainingQty = pool.lot.qty - sellQty;
            if (remainingQty > 1e-9) { pool.lot = { qty: remainingQty, price: pool.lot.price }; st.partialSells++; }
            else pool.lot = null;
            st.sells++;
          }
        }
      }
      // ---- ซื้อ ----
      if (isRedLong && !pool.lot && pool.cash >= MIN_TICKET) {
        const buyFrac = mode === "srSizing" ? (nearSupport ? BUY_FRAC_NEAR_SUPPORT : BUY_FRAC_BASE) : 1.0;
        const amt = pool.cash * buyFrac;
        if (amt >= MIN_TICKET) {
          const q = amt / price;
          pool.cash -= amt * (1 + FEE);
          pool.lot = { qty: q, price };
          st.buys++;
          if (buyFrac < 1) st.partialBuys++;
        }
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
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START} (แบ่ง ${POOL_COUNT} ก้อน $${POOL_CAP} ต่อก้อน)`);
console.log("กำลังหา swing high/low...");
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
  const sells = stats(runs.map((r) => r.sells));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อ ${buys.mean.toFixed(1)} ครั้ง | ขาย ${sells.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const flat = [], srSizing = [];
for (let t = 0; t < TRIALS; t++) {
  flat.push(simulate(all, atr, pivots, "flat"));
  srSizing.push(simulate(all, atr, pivots, "srSizing"));
}

summarize("3-pool ของเดิม (all-in $100 เสมอ, ขายเต็มเสมอ)", flat);
summarize("3-pool + ปรับขนาดตามแนวรับ-ต้าน (เก็บ floor 25%)", srSizing);
