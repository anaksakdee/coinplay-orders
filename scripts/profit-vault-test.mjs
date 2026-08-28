// เพิ่มกติกาใหม่: เงินทุนที่ใช้เทรด "คงที่เท่าต้นทุนเดิมเสมอ" ไม่โตขึ้นจากกำไร — ส่วนกำไรที่ขายได้จริง
// (proceeds - ต้นทุนของไม้นั้น) จะถูกแปลงเป็น BTC ทันทีแล้วเก็บเข้า "กรุ" ถาวร ไม่เอากลับมาเทรดอีกเลย
// ต่างจาก core เดิม (จัดสรรทุนไว้ล่วงหน้าตั้งแต่ต้น) ตรงที่กรุนี้ "ต้องทำกำไรจากฝีมือเทรดจริงก่อน"
// ถึงจะมีอะไรเข้ากรุ — ไม่ใช่เงินเปล่าที่จัดสรรไว้ล่วงหน้า สอดคล้องกับเป้าหมาย "ไม่มีเงินฟรี ต้องพิสูจน์ด้วยฝีมือ"
//
// ใช้กติกาซื้อ-ขายเดียวกับ pure-signal-test.mjs (ซื้อแดงยาว/ขายเขียวยาวเฉพาะกำไร ไม่มี stop-loss)
// เพิ่มแค่กลไก "แยกกำไรเข้ากรุ" เท่านั้น
//
// รันเอง: node scripts/profit-vault-test.mjs [รอบทดสอบ]
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
  let cash = START, tradingBtc = 0, vaultBtc = 0;
  let lots = []; // {qty, price, ts} — ไม้ที่ยังเทรดอยู่ (ทุนหมุนเวียน)
  let learned = null;
  const st = { buys: 0, sells: 0, profitToVaultUsd: 0 };
  let maxDrawdownDays = 0;

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
    // แยกกำไรเข้ากรุทันที: proceeds สุทธิ - ต้นทุนไม้นั้น(รวมค่าธรรมเนียมตอนซื้อ) = กำไร -> แปลงเป็น BTC เก็บกรุ
    // ต้นทุนไม้นั้นกลับเข้า cash เพื่อให้ทุนหมุนเวียนคงที่เท่าเดิมเสมอ ไม่โตไม่หดจากการเทรด
    if (isSpike && body > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        const proceeds = l.qty * price * (1 - FEE);
        const cost = l.qty * l.price * (1 + FEE); // เงินที่จ่ายจริงตอนซื้อไม้นี้ (รวมค่าธรรมเนียม)
        const profitUsd = proceeds - cost;
        if (profitUsd <= 0) continue; // ติดดอย ไม่ขาย รอต่อ
        cash += cost; // คืนทุนเข้ากองหมุนเวียน (คงที่)
        const vaultQty = profitUsd / price; // แปลงกำไรเป็น BTC ทันที ไม่ตั้งรอราคาถูกกว่า
        vaultBtc += vaultQty;
        st.profitToVaultUsd += profitUsd;
        tradingBtc -= l.qty;
        lots.splice(k, 1);
        st.sells++;
      }
    }

    // ---- ซื้อ: ไม้แดงยาว + คะแนนไม่ต่ำกว่าเกณฑ์ (ใช้เฉพาะเงินในกองหมุนเวียน) ----
    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy && cash >= MIN_TICKET) {
      const frac = positionFraction(score, an.atrPct);
      const amt = cash * frac;
      if (amt >= MIN_TICKET) {
        const q = amt / price;
        tradingBtc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, ts: c.t });
        st.buys++;
      }
    }

    if (lots.length) {
      const oldest = Math.min(...lots.map((l) => l.ts));
      const days = (c.t - oldest) / 86400e3;
      if (days > maxDrawdownDays) maxDrawdownDays = days;
    }
  }

  const last = candles[candles.length - 1].c;
  const holdCoins = START / candles[WARMUP].c;
  const totalBtc = tradingBtc + vaultBtc;
  const equity = cash + totalBtc * last;
  const holdEquity = holdCoins * last;
  return {
    ...st, cash, tradingBtc, vaultBtc, totalBtc, equity, holdEquity, openLots: lots.length, maxDrawdownDays,
    coinsVsHold: (totalBtc / holdCoins - 1) * 100,
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
console.log(`รัน ${TRIALS} รอบ (ทุนหมุนเวียนคงที่ + กำไรแปลงเป็น BTC เก็บกรุถาวร)\n`);

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
console.log(`  BTC รวมตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)} (ในนั้นอยู่ในกรุถาวรเฉลี่ย ${vault.mean.toFixed(8)})`);
console.log(`  เทียบถือยาว (เหรียญ): เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
console.log(`  Equity: เฉลี่ย $${eq.mean.toFixed(2)} | เทียบถือยาว (เงิน): เฉลี่ย ${eqVsHold.mean >= 0 ? "+" : ""}${eqVsHold.mean.toFixed(2)}% | sd ${eqVsHold.sd.toFixed(2)}%`);
