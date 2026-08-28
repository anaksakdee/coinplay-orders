// ต่อยอด three-pool-vault-test.mjs (ผลดีที่สุดวันนี้: +15.17% เหรียญ / +15.16% เงิน) — เพิ่มตัวกรอง volume
// ตามทฤษฎีที่ค้นมา (mean-reversion ตอน volume สูงกว่าปกติ 30%+ ชนะ 81% เทียบ 61% ถ้าไม่กรอง)
// ทดสอบว่าใช้ได้จริงไหมเมื่อรวมกับ 3-pool-vault ที่ชนะอยู่แล้ว
//
// รันเอง: node scripts/three-pool-volume-test.mjs [รอบทดสอบ] [เกณฑ์ volume ratio]
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
const VOL_WINDOW = 20;

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
function volRatioSeries(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = VOL_WINDOW; i < candles.length; i++) {
    let sum = 0;
    for (let k = i - VOL_WINDOW; k < i; k++) sum += candles[k].v || 0;
    const avg = sum / VOL_WINDOW;
    out[i] = avg > 0 ? (candles[i].v || 0) / avg : null;
  }
  return out;
}

// volMin: เกณฑ์ volume ratio ขั้นต่ำสำหรับ "ซื้อ" (0 = ไม่กรอง)
function simulate(candles, atr, volRatio, volMin) {
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, buysBlockedByVolume: 0 };

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;
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
    const vr = volRatio[i];
    const volOk = volMin <= 0 || vr == null || vr >= volMin;

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
        if (!volOk) { st.buysBlockedByVolume++; continue; }
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
const volRatio = volRatioSeries(all);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START} (แบ่ง ${POOL_COUNT} ก้อน $${POOL_START} ต่อก้อน)\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.coinsVsHold));
  const eq = stats(runs.map((r) => r.equityVsHold));
  const buys = stats(runs.map((r) => r.buys));
  const blocked = stats(runs.map((r) => r.buysBlockedByVolume));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อจริง ${buys.mean.toFixed(1)} ครั้ง | ถูกบล็อกเพราะ volume ${blocked.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
const VOL_MIN = Number(process.argv[3]) || 1.3; // ตามทฤษฎีที่เจอ (30% สูงกว่าปกติ)
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี | เกณฑ์ volume ratio = ${VOL_MIN}x\n`);

const noFilter = [], withFilter = [];
for (let t = 0; t < TRIALS; t++) {
  noFilter.push(simulate(all, atr, volRatio, 0));
  withFilter.push(simulate(all, atr, volRatio, VOL_MIN));
}

summarize("ไม่กรอง volume (ของเดิม)", noFilter);
summarize(`กรอง volume >= ${VOL_MIN}x`, withFilter);
