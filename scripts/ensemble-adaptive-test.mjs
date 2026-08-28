// ทดสอบแนวคิด "หลายกลยุทธ์แข่งกัน + น้ำหนักปรับอัตโนมัติ" จากแอพอ้างอิง (adaptive-engine.ts)
// ประยุกต์เข้ากับโครงกลยุทธ์ที่ชนะของเรา (3 ก้อน $100 คงที่ + กำไรเก็บกรุถาวร)
//
// 3 กลยุทธ์ที่แข่งกัน (ใช้กติกาขาย "กำไรแล้วค่อยขาย" เดียวกันทุกตัว ต่างแค่สัญญาณซื้อ):
//   A) Spike (ของเดิม): ซื้อไม้แดงยาว (ATR-based)
//   B) RSI Oversold: ซื้อเมื่อ RSI < 30
//   C) Bollinger Band: ซื้อเมื่อราคาต่ำกว่า/แตะ Bollinger Band ล่าง
//
// น้ำหนักแต่ละกลยุทธ์ปรับทุก 5 เทรดจริง ตาม PnL เฉลี่ยล่าสุด (softmax-like ตามแอพอ้างอิง)
// แต่ละก้อนสุ่มเลือกกลยุทธ์ตามน้ำหนักปัจจุบันตอนจะเปิดไม้ใหม่
//
// รันเอง: node scripts/ensemble-adaptive-test.mjs [รอบทดสอบ]
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

function simulate(candles, atr, opts = {}) {
  const useAdaptive = opts.adaptive !== false;
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, byStrategy: { spike: 0, rsi: 0, bb: 0 } };

  // น้ำหนัก 3 กลยุทธ์ + ตัวติดตามผลงานล่าสุด (เหมือน adaptive-engine.ts)
  let weights = { spike: 1 / 3, rsi: 1 / 3, bb: 1 / 3 };
  const perf = { spike: { pnl: 0, trades: 0 }, rsi: { pnl: 0, trades: 0 }, bb: { pnl: 0, trades: 0 } };
  let totalTrades = 0;

  function adaptWeights() {
    const scores = {};
    for (const k of ["spike", "rsi", "bb"]) {
      const avgPnl = perf[k].trades > 0 ? perf[k].pnl / perf[k].trades : 0;
      scores[k] = avgPnl; // pnl เฉลี่ยต่อเทรด (USD) เป็นคะแนนตรงๆ
    }
    const maxScore = Math.max(...Object.values(scores));
    const expScores = {};
    for (const k in scores) expScores[k] = Math.exp((scores[k] - maxScore) * 50); // ขยายความต่างให้ชัด
    const totalExp = Object.values(expScores).reduce((a, b) => a + b, 0);
    const newW = {};
    for (const k in expScores) newW[k] = Math.min(0.7, Math.max(0.1, (expScores[k] / totalExp) * 0.8 + 0.1));
    const sum = Object.values(newW).reduce((a, b) => a + b, 0);
    for (const k in newW) weights[k] = newW[k] / sum;
  }

  // ใช้ hash ของ index เป็นตัวสุ่มกำหนดว่าก้อนไหนเปิดไม้ด้วยกลยุทธ์อะไร (deterministic ต่อ index+poolIdx)
  function pickStrategy(seed) {
    const r = (Math.sin(seed * 12.9898) * 43758.5453) % 1;
    const rand = r < 0 ? r + 1 : r;
    let cum = 0;
    for (const k of ["spike", "rsi", "bb"]) {
      cum += weights[k];
      if (rand <= cum) return k;
    }
    return "bb";
  }

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
    const bb = sig.bb;

    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    const isGreenLong = isSpike && body > 0;
    const isRedLong = isSpike && body < 0 && score >= THRESHOLDS.weakBuy;
    const isRsiOversold = rsi != null && rsi < 30;
    const isBelowBB = bb && price <= bb.lower;

    for (let pi = 0; pi < pools.length; pi++) {
      const pool = pools[pi];
      // ---- ขาย: ไม้เขียวยาว (สัญญาณออกร่วมของทุกกลยุทธ์) + กำไรแล้ว ----
      if (isGreenLong && pool.lot) {
        const proceeds = pool.lot.qty * price * (1 - FEE);
        const cost = pool.lot.qty * pool.lot.price * (1 + FEE);
        const profitUsd = proceeds - cost;
        if (profitUsd > 0) {
          pool.cash += cost;
          vaultBtc += profitUsd / price;
          pool.lot = null;
          st.sells++;
          if (useAdaptive) {
            perf[pool.lastStrategy].pnl += profitUsd;
            perf[pool.lastStrategy].trades++;
            totalTrades++;
            if (totalTrades % 5 === 0) adaptWeights();
          }
        }
      }
      // ---- ซื้อ: เลือกกลยุทธ์ตามน้ำหนัก แล้วเช็คเงื่อนไขของกลยุทธ์นั้น ----
      if (!pool.lot && pool.cash >= MIN_TICKET) {
        const strat = useAdaptive ? pickStrategy(i * 7 + pi * 3 + 1) : "spike";
        let entryOk = false;
        if (strat === "spike") entryOk = isRedLong;
        else if (strat === "rsi") entryOk = isRsiOversold && score >= THRESHOLDS.weakBuy - 20;
        else if (strat === "bb") entryOk = isBelowBB && score >= THRESHOLDS.weakBuy - 20;

        if (entryOk) {
          const amt = pool.cash;
          const q = amt / price;
          pool.cash -= amt * (1 + FEE);
          pool.lot = { qty: q, price, strategy: strat };
          pool.lastStrategy = strat;
          st.buys++;
          st.byStrategy[strat]++;
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
    ...st, cash, tradingBtc, vaultBtc, totalBtc, equity, holdEquity, weights: { ...weights },
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
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${btc.mean.toFixed(2)}% | sd ${btc.sd.toFixed(2)}%`);
  console.log(`  เทียบถือยาว (เงิน): เฉลี่ย ${eq.mean >= 0 ? "+" : ""}${eq.mean.toFixed(2)}% | sd ${eq.sd.toFixed(2)}%`);
  console.log(`  ซื้อจริง ${buys.mean.toFixed(1)} ครั้ง`);
  const last = runs[runs.length - 1];
  console.log(`  ตัวอย่างสัดส่วนกลยุทธ์รอบสุดท้าย: spike=${last.byStrategy.spike}, rsi=${last.byStrategy.rsi}, bb=${last.byStrategy.bb} | น้ำหนักท้ายสุด: spike=${last.weights.spike.toFixed(2)}, rsi=${last.weights.rsi.toFixed(2)}, bb=${last.weights.bb.toFixed(2)}`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const spikeOnly = [], adaptiveEnsemble = [];
for (let t = 0; t < TRIALS; t++) {
  spikeOnly.push(simulate(all, atr, { adaptive: false }));
  adaptiveEnsemble.push(simulate(all, atr, { adaptive: true }));
}

summarize("Spike อย่างเดียว (ของเดิม)", spikeOnly);
summarize("Ensemble 3 กลยุทธ์ + น้ำหนักปรับอัตโนมัติ", adaptiveEnsemble);
