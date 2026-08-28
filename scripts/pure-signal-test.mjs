// กลยุทธ์ตามที่เสนอล่าสุด แบบง่ายที่สุด: "ซื้อไม้แดงยาว ขายไม้เขียวยาว" เท่านั้น
// - ซื้อ: เจอไม้แดงยาว (ตามเกณฑ์เดิม >1.5xATR, body% พอคุ้มค่าธรรมเนียม) ใช้เงินสดที่มีตาม positionFraction
// - ขาย: เจอไม้เขียวยาว "และ" ไม้นั้นกำไรสุทธิแล้วเท่านั้น — ถ้ายังไม่กำไร "ติดดอยไปก่อน" ไม่ขายขาดทุนเด็ดขาด
//   รอไม้เขียวยาวรอบถัดไปที่ราคาสูงพอจะกำไรแล้วค่อยขาย ไม่มี target ตายตัว ไม่มี stop-loss ไม่มีคิวรอราคา
//   ไม่มี core — เงินสดที่ขายได้กลับมาเป็นเงินสดว่างพร้อมซื้อไม้แดงยาวรอบถัดไปทันที
//
// รันเอง: node scripts/pure-signal-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS, positionFraction } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
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

function simulate(candles, atr) {
  let cash = START, btc = 0;
  let lots = []; // {qty, price}
  let learned = null;
  const st = { buys: 0, sells: 0, sellSkippedUnderwater: 0 };
  let maxDrawdownDays = 0, oldestOpenLotAt = null;

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

    // ---- ขาย: ไม้เขียวยาว + เฉพาะไม้ที่กำไรสุทธิแล้ว ----
    if (isSpike && body > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        const netPnlPct = (price * (1 - FEE) / (l.price * (1 + FEE)) - 1) * 100;
        if (netPnlPct <= 0) { st.sellSkippedUnderwater++; continue; } // ติดดอย ไม่ขาย รอต่อ
        const amt = l.qty * price;
        if (amt < MIN_TICKET) continue;
        cash += amt * (1 - FEE); btc -= l.qty;
        lots.splice(k, 1);
        st.sells++;
      }
    }

    // ---- ซื้อ: ไม้แดงยาว + คะแนนไม่ต่ำกว่าเกณฑ์ ----
    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy && cash >= MIN_TICKET) {
      const frac = positionFraction(score, an.atrPct);
      const amt = cash * frac;
      if (amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, ts: c.t });
        st.buys++;
      }
    }

    // ---- ติดตามว่าไม้ที่ค้างนานสุดค้างมากี่วัน (วัดว่า "รอ" นานแค่ไหนจริงๆ) ----
    if (lots.length) {
      const oldest = Math.min(...lots.map((l) => l.ts));
      const days = (c.t - oldest) / 86400e3;
      if (days > maxDrawdownDays) { maxDrawdownDays = days; oldestOpenLotAt = oldest; }
    }
  }

  const last = candles[candles.length - 1].c;
  const holdCoins = START / candles[WARMUP].c;
  const equity = cash + btc * last;
  const holdEquity = holdCoins * last;
  return {
    ...st, cash, btc, equity, holdEquity, openLots: lots.length, maxDrawdownDays,
    coinsVsHold: (btc / holdCoins - 1) * 100,
    equityVsHold: (equity / holdEquity - 1) * 100,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบ (ซื้อแดงยาว/ขายเขียวยาวเฉพาะกำไร ไม่มี stop-loss ไม่มี target ตายตัว)\n`);

const runs = [];
for (let t = 0; t < TRIALS; t++) {
  const r = simulate(all, atr);
  runs.push(r);
  console.log(`  รอบ ${t + 1}/${TRIALS}: btc=${r.btc.toFixed(8)} (${r.coinsVsHold.toFixed(1)}%) | equity $${r.equity.toFixed(2)} (${r.equityVsHold >= 0 ? "+" : ""}${r.equityVsHold.toFixed(1)}%) | ซื้อ ${r.buys} ขาย ${r.sells} | ไม้ค้างสุดนาน ${r.maxDrawdownDays.toFixed(0)} วัน | ไม้เปิดค้างตอนจบ ${r.openLots}`);
}

const btc = stats(runs.map((r) => r.btc));
const vsHold = stats(runs.map((r) => r.coinsVsHold));
const eq = stats(runs.map((r) => r.equity));
const eqVsHold = stats(runs.map((r) => r.equityVsHold));
console.log(`\n### สรุป (n=${TRIALS})`);
console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
console.log(`  Equity: เฉลี่ย $${eq.mean.toFixed(2)} | เทียบถือยาว (เงิน): เฉลี่ย ${eqVsHold.mean >= 0 ? "+" : ""}${eqVsHold.mean.toFixed(2)}% | sd ${eqVsHold.sd.toFixed(2)}%`);
