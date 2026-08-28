// ต่อยอดจาก three-pool-vault-test.mjs (ผลดีที่สุดวันนี้: +13.8% ถึง +15.8%) — ทดสอบไอเดียล่าสุด:
// "เทรดเฉพาะช่วงไซด์เวย์" — อนุญาตให้ "ซื้อ" ไม้ใหม่เฉพาะตอน regime เป็นไซด์เวย์เท่านั้น (ไม่ใช่ขาขึ้น/ขาลงแรง)
// เหตุผล: mean-reversion (ซื้อไม้แดง/ขายไม้เขียว) เข้าท่าที่สุดตอนราคาแกว่งไปมาไม่มีเทรนด์ชัด ตอนเทรนด์แรง
// (ขาขึ้น/ขาลง 2020-2021 ที่เคยทำร้ายกลยุทธ์นี้มาก่อน) mean-reversion มักโดนสวนทาง
// ฝั่งขาย (กำไรแล้วขาย) ยังทำได้ทุก regime เหมือนเดิม (ขายทำกำไรไม่มีทางเสีย)
//
// รันเอง: node scripts/three-pool-sideways-test.mjs [รอบทดสอบ]
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
const REGIME_WINDOW_H = 90 * 24;
const REGIME_THRESHOLD = 0.20;

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
function regimeSeries(candles) {
  const regimes = new Array(candles.length).fill("sideways");
  for (let i = 0; i < candles.length; i++) {
    const j = i - REGIME_WINDOW_H;
    if (j < 0) continue;
    const ret = candles[i].c / candles[j].c - 1;
    regimes[i] = ret > REGIME_THRESHOLD ? "bull" : ret < -REGIME_THRESHOLD ? "bear" : "sideways";
  }
  return regimes;
}

// buyRegimes: array ของ regime ที่อนุญาตให้ซื้อ เช่น ["sideways"] หรือ ["sideways","bear"] หรือ null=ไม่กรอง (ซื้อได้ทุก regime)
function simulate(candles, atr, regimes, buyRegimes) {
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, buysBlockedByRegime: 0 };

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
    const regimeOk = !buyRegimes || buyRegimes.includes(regimes[i]);

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
        if (!regimeOk) { st.buysBlockedByRegime++; continue; }
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
const regimes = regimeSeries(all);
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
  const blocked = stats(runs.map((r) => r.buysBlockedByRegime));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อจริง ${buys.mean.toFixed(1)} ครั้ง | ถูกบล็อกเพราะ regime ${blocked.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const allRegime = [], sidewaysOnly = [], sidewaysBear = [];
for (let t = 0; t < TRIALS; t++) {
  allRegime.push(simulate(all, atr, regimes, null));
  sidewaysOnly.push(simulate(all, atr, regimes, ["sideways"]));
  sidewaysBear.push(simulate(all, atr, regimes, ["sideways", "bear"]));
}

summarize("ทุก regime (ของเดิม — ไม่กรอง)", allRegime);
summarize("ซื้อเฉพาะไซด์เวย์", sidewaysOnly);
summarize("ซื้อเฉพาะไซด์เวย์ + ขาลง", sidewaysBear);
