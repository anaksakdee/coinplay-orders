// ต่อยอด three-pool-vault-test.mjs (ผลดีที่สุด: +15.17% ถึง +15.63%) — เพิ่มตัวยืนยัน MACD คู่กับ RSI
// บนสัญญาณซื้อไม้แดงยาวเดิม (ไม่ใช่แทนที่ — ตามที่ทดสอบ ensemble ไปแล้วว่าแทนที่ทำให้แย่ลง)
//
// เงื่อนไขเพิ่ม: ต้อง RSI ไม่อยู่ในโซน overbought (>70) และ MACD histogram เป็นบวกหรือกำลังพลิกขึ้น
// (สองตัวเสริมกัน — RSI กันไม่ให้ซื้อไม้แดงยาวตอนที่จริงๆ ยังอยู่ในทิศ momentum ขาลงหนัก, MACD ยืนยันว่า
// โมเมนตัมเริ่มกลับตัว) ทดสอบทั้ง 3 แบบ: RSI อย่างเดียว, MACD อย่างเดียว, RSI+MACD ร่วมกัน
//
// รันเอง: node scripts/three-pool-macd-rsi-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns, computeSignal } from "../shared/signals.mjs";
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

// mode: "none" | "rsi" | "macd" | "both"
function simulate(candles, atr, mode) {
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, blocked: 0 };
  let prevHist = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;
    if (i % LEARN_EVERY === 0 || !learned) {
      const w = candles.slice(Math.max(0, i - 900), i + 1);
      learned = evaluateIndicators(w, 20, 60) || learned;
    }
    const win = candles.slice(Math.max(0, i - SCORE_WINDOW), i + 1);
    const returns = computeReturns(win);
    const an = scoreMarket(price, win, returns, learned);
    const score = an.composite;
    if (!Number.isFinite(score)) continue;
    const sig = computeSignal(price, win, returns);
    const rsi = sig.rsi;
    const hist = sig.macd ? sig.macd.histogram : null;

    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    const isGreenLong = isSpike && body > 0;
    const isRedLong = isSpike && body < 0 && score >= THRESHOLDS.weakBuy;

    let confirmOk = true;
    if (mode === "rsi" || mode === "both") {
      confirmOk = confirmOk && (rsi == null || rsi < 70); // ไม่ overbought
    }
    if (mode === "macd" || mode === "both") {
      const macdRising = hist != null && prevHist != null && hist > prevHist;
      const macdOk = hist == null || hist > 0 || macdRising; // เป็นบวก หรือกำลังพลิกขึ้น
      confirmOk = confirmOk && macdOk;
    }
    prevHist = hist;

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
        if (!confirmOk) { st.blocked++; continue; }
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
  const blocked = stats(runs.map((r) => r.blocked));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อจริง ${buys.mean.toFixed(1)} ครั้ง | ถูกบล็อก ${blocked.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const modes = { none: [], rsi: [], macd: [], both: [] };
for (let t = 0; t < TRIALS; t++) {
  for (const m of Object.keys(modes)) modes[m].push(simulate(all, atr, m));
}

summarize("ไม่กรอง (ของเดิม)", modes.none);
summarize("กรองด้วย RSI (ไม่ overbought)", modes.rsi);
summarize("กรองด้วย MACD (บวกหรือพลิกขึ้น)", modes.macd);
summarize("กรองด้วย RSI+MACD ร่วมกัน", modes.both);
