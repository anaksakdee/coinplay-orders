// ทดสอบฟีเจอร์ใหม่ "ใช้ volume เป็นตัวกรองไม้ยาว" — เพิ่มจากกลยุทธ์เดิม (ไม่แทนที่)
// มาจากการวิเคราะห์แพทเทิร์นไม้ยาว 9 ปี (scripts/spike-pattern-analysis.mjs) ที่พบว่า volume สูงกว่าปกติ
// ตอนเกิดไม้ยาวคือสัญญาณที่แข็งแรงที่สุด (เฉลี่ย ~4 เท่าของ 20 แท่งก่อนหน้า, ~80-90% ของไม้ยาวสูงกว่า 2 เท่า)
// สมมติฐาน: ไม้ยาวที่ volume ไม่สูงตามอาจเป็นสัญญาณปลอม/สภาพคล่องบาง ควรกรองออกก่อนเข้าเทรดจริง
//
// จำลองตรรกะทั้งระบบให้ตรงกับ scripts/check-orders.mjs ปัจจุบันเป๊ะ (หลังปิด stop_loss/lock_profit_bearish
// และเพิ่ม forecast target แล้ว — ดู scripts/forecast-target-test.mjs) เป็น baseline แล้วเพิ่มตัวกรอง volume
//
// รันเอง: node scripts/volume-filter-test.mjs [รอบทดสอบ] [เกณฑ์ volume ratio]
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
const CORE_INTERVAL_MS = 12 * 3600e3, CORE_FRAC = 0.05, CORE_MAX = 0.50;
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
const ceilingFor = (sp) => (sp * (1 - FEE)) / ((1 + FEE) * (1 + BTC_ACCUM_TARGET));

// อัตราส่วน volume ของแท่ง i เทียบค่าเฉลี่ย VOL_WINDOW แท่งก่อนหน้า (ไม่รวมแท่งตัวเอง)
function volRatioSeries(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = VOL_WINDOW; i < candles.length; i++) {
    let sum = 0, n = 0;
    for (let k = i - VOL_WINDOW; k < i; k++) { sum += candles[k].v || 0; n++; }
    const avg = n ? sum / n : 0;
    out[i] = avg > 0 ? (candles[i].v || 0) / avg : null;
  }
  return out;
}

function simulate(candles, atr, volRatio, opts = {}) {
  const volMin = opts.volMin || 0; // 0 = ไม่กรอง

  let cash = START, btc = 0;
  let lots = [];
  let orders = [];
  let lastSell = null;
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  const st = {
    coreBuys: 0, spikeSells: 0, spikeRebuys: 0,
    signalBuys: 0, accumRebuys: 0, coinsFromCycles: 0, forecastSells: 0, volFiltered: 0,
  };

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
    const forecast = an.signal && an.signal.forecast;

    // ---- 1) คำสั่งรอราคา ----
    for (let k = orders.length - 1; k >= 0; k--) {
      const o = orders[k];
      if (c.l > o.target) continue;
      const need = o.amount * (1 + FEE);
      if (need <= cash && o.amount >= MIN_TICKET) {
        const q = o.amount / o.target;
        btc += q; cash -= need;
        lots.push({ qty: q, price: o.target, sleeve: "swing", fcTarget: null });
        st.spikeRebuys++; st.coinsFromCycles += q - o.qtySold;
      }
      orders.splice(k, 1);
    }

    // ---- (เดิมมีขั้นตอนตัดขาดทุน stop_loss/lock_profit_bearish ตรงนี้ — ปิดถาวรแล้วในโค้ดจริง
    // เพราะพิสูจน์แล้วว่าทำลายพอร์ตแบบเดียวกัน ดู scripts/forecast-target-test.mjs) ----

    // ---- forecast target (p90 รี้ดขึ้น) ----
    if (forecast && forecast.p90 > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        l.fcTarget = l.fcTarget == null ? forecast.p90 : Math.max(l.fcTarget, forecast.p90);
        const netPnlPct = (price * (1 - FEE) / (l.price * (1 + FEE)) - 1) * 100;
        if (price >= l.fcTarget && netPnlPct > 0) {
          const amt = l.qty * price;
          if (amt < MIN_TICKET) continue;
          cash += amt * (1 - FEE); btc -= l.qty;
          lastSell = { price, usd: amt, qty: l.qty };
          lots.splice(k, 1);
          st.forecastSells++;
        }
      }
    }

    // ---- ไม้ยาว: ตรวจก่อนว่ายาวพอไหม แล้วค่อยเช็ค volume กรองซ้ำ ----
    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const longEnough = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    const vr = volRatio[i];
    const volOk = volMin <= 0 || vr == null || vr >= volMin; // ไม่มีข้อมูล volume ไม่บล็อก (กันพังตอน feed ล่ม)
    const isSpike = longEnough && volOk;
    if (longEnough && !volOk) st.volFiltered++;

    // ---- 1b) ไม้เขียวยาว -> ขายรับรอบ 50% ----
    if (isSpike && body > 0 && orders.length < SPIKE_MAX_OPEN) {
      const swing = lots.filter((l) => l.sleeve !== "core");
      const swingBtc = swing.reduce((s, l) => s + l.qty, 0);
      let want = swingBtc * SPIKE_PCT;
      if (want * price >= MIN_TICKET) {
        let sold = 0;
        for (let k = 0; k < lots.length && want > 1e-12; k++) {
          const l = lots[k];
          if (l.sleeve === "core") continue;
          const take = Math.min(l.qty, want);
          l.qty -= take; want -= take; sold += take;
        }
        lots = lots.filter((l) => l.qty > 1e-12);
        const gross = sold * price;
        cash += gross * (1 - FEE); btc -= sold;
        orders.push({ target: price - SPIKE_RETRACE * body, amount: (gross * (1 - FEE)) / (1 + FEE), qtySold: sold });
        st.spikeSells++;
      }
    }

    // ---- 2a) ขา core ----
    const coreLeft = START * CORE_MAX - coreSpent;
    if (c.t - lastCoreAt >= CORE_INTERVAL_MS && score > THRESHOLDS.strongSell && coreLeft >= MIN_TICKET) {
      const amt = Math.min(coreLeft, Math.max(MIN_TICKET, START * CORE_FRAC));
      if (amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "core", fcTarget: null });
        coreSpent += amt; lastCoreAt = c.t; st.coreBuys++;
        continue;
      }
    }

    // ---- 2b) ซื้อคืนหลังขาย ----
    if (lastSell && lastSell.qty > 0) {
      if (price > ceilingFor(lastSell.price)) continue;
      const amt = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (amt * (1 + FEE) <= cash && amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        st.coinsFromCycles += q - lastSell.qty; st.accumRebuys++;
      }
      lastSell = null;
      continue;
    }

    // ---- 2c) ซื้อไม้แดงยาวตามสัญญาณ ----
    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy) {
      const frac = positionFraction(score, an.atrPct);
      const amt = cash * frac;
      if (amt >= MIN_TICKET && amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        st.signalBuys++;
      }
    }
  }

  const last = candles[candles.length - 1].c;
  const holdCoins = START / candles[WARMUP].c;
  return {
    ...st, cash, btc,
    coreCoins: lots.filter((l) => l.sleeve === "core").reduce((s, l) => s + l.qty, 0),
    coinsVsHold: (btc / holdCoins - 1) * 100,
    openOrders: orders.length,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
const volRatio = volRatioSeries(all);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}`);
console.log(`ราคา ${all[WARMUP].c.toFixed(0)} -> ${all[all.length - 1].c.toFixed(0)}\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  const spikeSells = stats(runs.map((r) => r.spikeSells));
  const signalBuys = stats(runs.map((r) => r.signalBuys));
  const filtered = stats(runs.map((r) => r.volFiltered));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
  console.log(`  ไม้ยาวขาย(เขียว) เฉลี่ย ${spikeSells.mean.toFixed(1)} | ซื้อสัญญาณ(แดง) เฉลี่ย ${signalBuys.mean.toFixed(1)} | ไม้ที่โดนกรองทิ้งด้วย volume เฉลี่ย ${filtered.mean.toFixed(1)}`);
}

const TRIALS = Number(process.argv[2]) || 8;
const VOL_MIN = Number(process.argv[3]) || 2.0;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี | เกณฑ์ volume ratio ขั้นต่ำ = ${VOL_MIN}x\n`);

const baseline = [], filtered = [];
for (let t = 0; t < TRIALS; t++) {
  const rb = simulate(all, atr, volRatio, { volMin: 0 });
  const rf = simulate(all, atr, volRatio, { volMin: VOL_MIN });
  baseline.push(rb); filtered.push(rf);
  console.log(`  รอบ ${t + 1}/${TRIALS}: baseline btc=${rb.btc.toFixed(8)} (${rb.coinsVsHold.toFixed(1)}%) | +volume filter btc=${rf.btc.toFixed(8)} (${rf.coinsVsHold.toFixed(1)}%)`);
}

summarize("ปัจจุบัน (ไม่กรอง volume)", baseline);
summarize(`เพิ่มตัวกรอง volume >= ${VOL_MIN}x`, filtered);
