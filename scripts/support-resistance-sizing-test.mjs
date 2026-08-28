// ไอเดียใหม่: ไม่ใช้แนวรับ-แนวต้านเป็นตัว "บล็อก" การเข้าไม้ (แบบที่เคยทดสอบแล้วพัง -76%)
// แต่ใช้เป็นตัว "ปรับขนาดไม้" แทน — ตามที่เสนอ:
//   - ไม้แดงยาวใกล้แนวรับ -> ซื้อหนักขึ้น (วางเดิมพันเยอะ)
//   - ไม้เขียวยาวใกล้แนวต้าน -> ขายหนักขึ้น (แต่เก็บ BTC ไว้อย่างน้อย 25% เสมอ ไม่ขายหมด)
// ใช้โครงสร้างเงินก้อนเดียว + ขนาดไม้แบบต่อเนื่อง (ต่างจาก 3-pool ที่ all-in ตายตัว)
// กำไรจากการหมุนรอบยังเก็บเข้ากรุถาวรเหมือนเดิม (ทุนหมุนเวียนคงที่)
//
// รันเอง: node scripts/support-resistance-sizing-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const MIN_TICKET = 5;
const SPIKE_ATR_MULT = 1.5;
const SPIKE_FEE_SAFETY = 2.5, SPIKE_RETRACE = 0.20;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;

const PIVOT_WINDOW_H = 24;
const LEVEL_TOLERANCE = 0.01;
const MIN_TOUCHES = 3;
const NEAR_LEVEL_PCT = 0.02;

// ขนาดไม้ซื้อ: ปกติ 20% ของทุนหมุนเวียน, ใกล้แนวรับ -> 70%
const BUY_FRAC_BASE = 0.20, BUY_FRAC_NEAR_SUPPORT = 0.70;
// ขนาดขาย: ปกติขาย 30% ของที่ถืออยู่, ใกล้แนวต้าน -> 75% แต่เก็บ floor 25% ของ "ยอดสูงสุดที่เคยถือ" เสมอ
const SELL_FRAC_BASE = 0.30, SELL_FRAC_NEAR_RESIST = 0.75;
const KEEP_FLOOR_PCT = 0.25;

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

// mode: "flat" (ของเดิม ไม่ปรับขนาดตามแนว) | "srSizing" (ปรับขนาดตามแนวรับ-ต้าน)
function simulate(candles, atr, pivots, mode) {
  let cash = START, btc = 0;
  let lots = []; // {qty, price} — FIFO cost basis รวมกันเป็นก้อนเดียว ไม่แยกพูล
  let vaultBtc = 0;
  let peakBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0 };
  const supportCounts = new Map(), resistCounts = new Map();
  let lowIdx = 0, highIdx = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;

    while (lowIdx < pivots.lows.length && pivots.lows[lowIdx].confirmAt <= i) {
      supportCounts.set(bucketKey(pivots.lows[lowIdx].price), (supportCounts.get(bucketKey(pivots.lows[lowIdx].price)) || 0) + 1);
      lowIdx++;
    }
    while (highIdx < pivots.highs.length && pivots.highs[highIdx].confirmAt <= i) {
      resistCounts.set(bucketKey(pivots.highs[highIdx].price), (resistCounts.get(bucketKey(pivots.highs[highIdx].price)) || 0) + 1);
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

    // ---- ขาย: ไม้เขียวยาว (ขายจาก FIFO เท่าที่ "กำไรรวม" เป็นบวก ง่ายสุดคือขายตามสัดส่วนที่ยังไม่เจาะจงไม้) ----
    if (isGreenLong && btc > 1e-9) {
      const avgCost = lots.reduce((s, l) => s + l.qty * l.price, 0) / lots.reduce((s, l) => s + l.qty, 0);
      const netPnlPct = (price * (1 - FEE) / (avgCost * (1 + FEE)) - 1) * 100;
      if (netPnlPct > 0) {
        const nearResist = mode === "srSizing" && nearSignificantLevel(price, resistCounts);
        const sellFrac = mode === "srSizing" ? (nearResist ? SELL_FRAC_NEAR_RESIST : SELL_FRAC_BASE) : SELL_FRAC_BASE;
        let sellQty = btc * sellFrac;
        // เก็บ floor 25% ของยอดสูงสุดที่เคยถือ เสมอ
        const floor = peakBtc * KEEP_FLOOR_PCT;
        if (btc - sellQty < floor) sellQty = Math.max(0, btc - floor);
        if (sellQty * price >= MIN_TICKET) {
          const proceeds = sellQty * price * (1 - FEE);
          const cost = sellQty * avgCost * (1 + FEE);
          const profitUsd = proceeds - cost;
          cash += cost;
          vaultBtc += Math.max(0, profitUsd) / price;
          // ลด lots ตามสัดส่วน (FIFO คร่าวๆ)
          let remaining = sellQty;
          const newLots = [];
          for (const l of lots) {
            if (remaining <= 1e-12) { newLots.push(l); continue; }
            if (l.qty <= remaining) { remaining -= l.qty; } else { newLots.push({ qty: l.qty - remaining, price: l.price }); remaining = 0; }
          }
          lots = newLots;
          btc -= sellQty;
          st.sells++;
        }
      }
    }

    // ---- ซื้อ: ไม้แดงยาว ----
    if (isRedLong && cash >= MIN_TICKET) {
      const nearSupport = mode === "srSizing" && nearSignificantLevel(price, supportCounts);
      const buyFrac = mode === "srSizing" ? (nearSupport ? BUY_FRAC_NEAR_SUPPORT : BUY_FRAC_BASE) : BUY_FRAC_BASE;
      const amt = cash * buyFrac;
      if (amt >= MIN_TICKET) {
        const q = amt / price;
        cash -= amt * (1 + FEE);
        btc += q;
        lots.push({ qty: q, price });
        st.buys++;
      }
    }

    peakBtc = Math.max(peakBtc, btc);
  }

  const last = candles[candles.length - 1].c;
  const totalBtc = btc + vaultBtc;
  const holdCoins = START / candles[WARMUP].c;
  const equity = cash + totalBtc * last;
  const holdEquity = holdCoins * last;
  return {
    ...st, cash, tradingBtc: btc, vaultBtc, totalBtc, equity, holdEquity,
    coinsVsHold: (totalBtc / holdCoins - 1) * 100,
    equityVsHold: (equity / holdEquity - 1) * 100,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}`);
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

summarize("ขนาดไม้คงที่ (ไม่ดูแนวรับ-ต้าน)", flat);
summarize("ปรับขนาดตามแนวรับ-ต้าน (ซื้อหนักใกล้แนวรับ/ขายหนักใกล้แนวต้าน เก็บ 25%)", srSizing);
