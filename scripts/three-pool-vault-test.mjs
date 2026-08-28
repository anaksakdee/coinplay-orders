// รวมทุกไอเดียล่าสุด: แบ่งทุนเป็น 3 ก้อน ก้อนละ $100 (คงที่ ไม่โตไม่หด) แต่ละก้อนถือได้ทีละ 1 ไม้
// ซื้อไม้แดงยาว ขายไม้เขียวยาวเฉพาะไม้ที่กำไรแล้ว (ติดดอยก็รอต่อ ไม่มี stop-loss ไม่มี target ตายตัว)
// กำไรที่ขายได้จริงแปลงเป็น BTC เก็บกรุถาวรทันที ต้นทุนกลับเข้าก้อนเดิมให้คงที่ $100 เสมอ
//
// รันเอง: node scripts/three-pool-vault-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const POOL_COUNT = 3;
const POOL_START = START / POOL_COUNT; // $100 ต่อก้อน
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

// pool = { cash, lot: {qty, price} | null }
function simulate(candles, atr) {
  const pools = Array.from({ length: POOL_COUNT }, () => ({ cash: POOL_START, lot: null }));
  let vaultBtc = 0;
  let learned = null;
  const st = { buys: 0, sells: 0, profitToVaultUsd: 0 };

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

    for (const pool of pools) {
      // ---- ขาย: ไม้เขียวยาว + กำไรแล้วเท่านั้น ----
      if (isGreenLong && pool.lot) {
        const proceeds = pool.lot.qty * price * (1 - FEE);
        const cost = pool.lot.qty * pool.lot.price * (1 + FEE);
        const profitUsd = proceeds - cost;
        if (profitUsd > 0) {
          pool.cash += cost; // คืนทุนให้ก้อนคงที่ $100 เสมอ
          vaultBtc += profitUsd / price; // กำไรแปลงเป็น BTC เก็บกรุถาวรทันที
          st.profitToVaultUsd += profitUsd;
          pool.lot = null;
          st.sells++;
        }
        // ถ้ายังไม่กำไร ติดดอยไปก่อน ไม่ขาย
      }
      // ---- ซื้อ: ไม้แดงยาว + ก้อนนี้ว่างอยู่ ----
      if (isRedLong && !pool.lot && pool.cash >= MIN_TICKET) {
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
    openLots: pools.filter((p) => p.lot).length,
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

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบ\n`);

const runs = [];
for (let t = 0; t < TRIALS; t++) {
  const r = simulate(all, atr);
  runs.push(r);
  console.log(`  รอบ ${t + 1}/${TRIALS}: รวม btc=${r.totalBtc.toFixed(8)} (${r.coinsVsHold.toFixed(1)}%) [หมุนเวียน ${r.tradingBtc.toFixed(8)} + กรุ ${r.vaultBtc.toFixed(8)}] | equity $${r.equity.toFixed(2)} (${r.equityVsHold >= 0 ? "+" : ""}${r.equityVsHold.toFixed(1)}%) | ซื้อ ${r.buys} ขาย ${r.sells}`);
}

const btc = stats(runs.map((r) => r.totalBtc));
const vsHold = stats(runs.map((r) => r.coinsVsHold));
const eq = stats(runs.map((r) => r.equity));
const eqVsHold = stats(runs.map((r) => r.equityVsHold));
const vault = stats(runs.map((r) => r.vaultBtc));
console.log(`\n### สรุป (n=${TRIALS})`);
console.log(`  BTC รวมตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)} (กรุถาวรเฉลี่ย ${vault.mean.toFixed(8)})`);
console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
console.log(`  Equity: เฉลี่ย $${eq.mean.toFixed(2)} | เทียบถือยาว (เงิน): เฉลี่ย ${eqVsHold.mean >= 0 ? "+" : ""}${eqVsHold.mean.toFixed(2)}% | sd ${eqVsHold.sd.toFixed(2)}%`);
