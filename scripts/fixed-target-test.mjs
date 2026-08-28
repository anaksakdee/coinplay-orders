// ทดสอบไอเดียที่ผู้ใช้เสนอ: ซื้อไม้แดงยาวตอนขาลง จดจำราคาที่ซื้อไว้ ขายเมื่อกำไร 2% คงที่ (ไม่ใช้ forecast)
// ถ้าราคาไม่ย่อกลับมาให้ซื้อคืนตามเพดานเดิม (ตอนตลาดวิ่งขึ้นต่อเนื่องไม่ย่อ) ให้ "ตั้งเพดานใหม่" ไล่ตามราคา
// เป็นระยะ แทนที่จะค้างรอราคาเดิมตลอดไป (แก้ปัญหาเดียวกับที่คิวหลายช่องแก้ แต่เพิ่มการไล่ตามราคาด้วย)
//
// เทียบกับกลยุทธ์ forecast-target ปัจจุบัน (scripts/multislot-rebuy-test.mjs) บนโครงสร้างเดียวกันทุกอย่าง
// อื่น (สัญญาณซื้อไม้แดงยาว, ไม้เขียวยาวขายรับรอบ, คิวหลายช่อง) ต่างแค่กติกาขาย/ซื้อคืนของไม้ signal_buy
//
// รันเอง: node scripts/fixed-target-test.mjs [รอบทดสอบ] [ratchetHours]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS, positionFraction } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const MIN_TICKET = 5;
const BTC_ACCUM_TARGET = 0.0025;
const SPIKE_ATR_MULT = 1.5, SPIKE_PCT = 0.50, SPIKE_MAX_OPEN = 3, SPIKE_RETRACE = 0.20;
const SPIKE_FEE_SAFETY = 2.5;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;
const TARGET_MAX_OPEN = 3;
const PROFIT_TARGET = 0.02; // +2% ตามที่เสนอ

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
const ceilingFor = (sp) => (sp * (1 - FEE)) / ((1 + FEE) * (1 + BTC_ACCUM_TARGET));

// ratchetHours: ถ้า order ค้างนานเกินนี้ (ราคาไม่ย่อกลับ) ให้ "ตั้งเพดานใหม่" ไล่ตามราคาปัจจุบัน
// (ตามไอเดีย "ถ้ากราฟขึ้นไปแล้วตั้งเพดานใหม่") — 0 = ปิดฟีเจอร์นี้ (เพดานเดิมตลอดไป)
function simulate(candles, atr, opts = {}) {
  const ratchetMs = (opts.ratchetHours || 0) * 3600e3;
  let cash = START, btc = 0;
  let lots = [];
  let orders = []; // {target, amount, qtySold, kind:'spike'|'target', createdAt, lastRatchetAt}
  let learned = null;
  const st = { spikeSells: 0, spikeRebuys: 0, signalBuys: 0, targetSells: 0, targetRebuys: 0, ratchets: 0 };

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

    // ---- ไล่เพดานใหม่ให้ order ที่ค้างนาน (เฉพาะ kind:'target') ----
    if (ratchetMs > 0) {
      for (const o of orders) {
        if (o.kind !== "target") continue;
        if (c.t - (o.lastRatchetAt || o.createdAt) >= ratchetMs && price < o.target) {
          // ตั้งเพดานใหม่ให้ใกล้ราคาปัจจุบันขึ้น (ยังต้องได้เหรียญเพิ่มขึ้นจากเดิมอยู่ดี ไม่ใช่ยอมซื้อแพงกว่าที่ขาย)
          const newCeiling = ceilingFor(price);
          if (newCeiling < o.target) { o.target = newCeiling; st.ratchets++; }
          o.lastRatchetAt = c.t;
        }
      }
    }

    // ---- คำสั่งรอราคา (ทั้ง spike-rebuy และ target-rebuy) ----
    for (let k = orders.length - 1; k >= 0; k--) {
      const o = orders[k];
      if (c.l > o.target) continue;
      const need = o.amount * (1 + FEE);
      if (need <= cash && o.amount >= MIN_TICKET) {
        const q = o.amount / o.target;
        btc += q; cash -= need;
        lots.push({ qty: q, price: o.target, sleeve: "swing" });
        if (o.kind === "target") st.targetRebuys++; else st.spikeRebuys++;
      }
      orders.splice(k, 1);
    }

    // ---- ขายไม้ signal_buy ที่กำไรถึง 2% (ตามที่เสนอ) ----
    for (let k = lots.length - 1; k >= 0; k--) {
      const l = lots[k];
      const netPnlPct = (price * (1 - FEE) / (l.price * (1 + FEE)) - 1) * 100;
      if (netPnlPct < PROFIT_TARGET * 100) continue;
      const openTarget = orders.filter((o) => o.kind === "target").length;
      if (openTarget >= TARGET_MAX_OPEN) continue;
      const amt = l.qty * price;
      if (amt < MIN_TICKET) continue;
      cash += amt * (1 - FEE); btc -= l.qty;
      lots.splice(k, 1);
      st.targetSells++;
      orders.push({ target: ceilingFor(price), amount: (amt * (1 - FEE)) / (1 + FEE), qtySold: l.qty, kind: "target", createdAt: c.t });
    }

    // ---- ไม้เขียวยาว -> ขายรับรอบ 50% + ตั้งซื้อคืน ----
    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    if (isSpike && body > 0 && orders.filter((o) => o.kind !== "target").length < SPIKE_MAX_OPEN) {
      const swingBtc = lots.reduce((s, l) => s + l.qty, 0);
      let want = swingBtc * SPIKE_PCT;
      if (want * price >= MIN_TICKET) {
        let sold = 0;
        for (let k = 0; k < lots.length && want > 1e-12; k++) {
          const l = lots[k];
          const take = Math.min(l.qty, want);
          l.qty -= take; want -= take; sold += take;
        }
        lots = lots.filter((l) => l.qty > 1e-12);
        const gross = sold * price;
        cash += gross * (1 - FEE); btc -= sold;
        orders.push({ target: price - SPIKE_RETRACE * body, amount: (gross * (1 - FEE)) / (1 + FEE), qtySold: sold, createdAt: c.t });
        st.spikeSells++;
      }
    }

    // ---- ซื้อไม้แดงยาวตามสัญญาณ ----
    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy) {
      const frac = positionFraction(score, an.atrPct);
      const amt = cash * frac;
      if (amt >= MIN_TICKET && amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing" });
        st.signalBuys++;
      }
    }
  }

  const last = candles[candles.length - 1].c;
  const holdCoins = START / candles[WARMUP].c;
  return { ...st, cash, btc, coinsVsHold: (btc / holdCoins - 1) * 100 };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  const ts = stats(runs.map((r) => r.targetSells));
  const tr = stats(runs.map((r) => r.targetRebuys));
  const rat = stats(runs.map((r) => r.ratchets));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
  console.log(`  ขายกำไร 2% ${ts.mean.toFixed(1)} ครั้ง | ซื้อคืนสำเร็จ ${tr.mean.toFixed(1)} ครั้ง (${(tr.mean / Math.max(1, ts.mean) * 100).toFixed(0)}%) | ตั้งเพดานใหม่ ${rat.mean.toFixed(1)} ครั้ง`);
}

const TRIALS = Number(process.argv[2]) || 8;
const RATCHET_H = Number(process.argv[3]) || 0;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบ | ratchet ${RATCHET_H ? "ทุก " + RATCHET_H + " ชม." : "ปิด (เพดานเดิมตลอด)"}\n`);

const noRatchet = [], withRatchet = [];
for (let t = 0; t < TRIALS; t++) {
  const rn = simulate(all, atr, { ratchetHours: 0 });
  const rw = simulate(all, atr, { ratchetHours: RATCHET_H || 24 * 14 }); // ดีฟอลต์ ratchet ทุก 14 วันถ้าไม่ระบุ
  noRatchet.push(rn); withRatchet.push(rw);
  console.log(`  รอบ ${t + 1}/${TRIALS}: 2%คงที่ไม่ ratchet btc=${rn.btc.toFixed(8)} (${rn.coinsVsHold.toFixed(1)}%) | +ratchet btc=${rw.btc.toFixed(8)} (${rw.coinsVsHold.toFixed(1)}%)`);
}

summarize("ขาย 2% คงที่ ไม่ไล่เพดาน", noRatchet);
summarize("ขาย 2% คงที่ + ไล่เพดานทุก 14 วัน", withRatchet);
