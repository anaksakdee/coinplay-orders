// ทดสอบฟีเจอร์ใหม่ "ขายตามราคาเป้าหมายจาก Monte Carlo forecast" (เพิ่มจากกลยุทธ์เดิม ไม่แทนที่)
// จำลองตรรกะ "ทั้งระบบ" ให้ตรงกับ scripts/check-orders.mjs ของจริงเป๊ะที่สุด:
//   1) ขายทำกำไร/ตัดขาดทุน (stop_loss / lock_profit_bearish) — เฉพาะไม้ swing
//   1b) ไม้เขียวยาว -> ขายรับรอบ 50% + ตั้งคำสั่งซื้อคืนที่ย่อ 20% ของลำตัวไม้
//   [ใหม่] forecast target: ทุกไม้ swing ที่เปิดอยู่ เช็คว่าราคาถึง p90 ของ Monte Carlo หรือยัง
//          เป้าหมาย "รี้ดขึ้นอย่างเดียว" (ratchet) ทุกรอบตาม forecast ล่าสุด ไม่มีวันลดลง
//   2) ซื้อ: core สะสมทุก 12ชม. -> ซื้อคืนหลังขายกำไร/ตัดขาดทุน (ceiling) -> ซื้อไม้แดงยาวตามสัญญาณ
//
// รันเอง: node scripts/forecast-target-test.mjs
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS, positionFraction } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const MIN_TICKET = 5;
const STOP_LOSS_PCT = 0.05;
const BTC_ACCUM_TARGET = 0.0025;
const SPIKE_ATR_MULT = 1.5, SPIKE_PCT = 0.50, SPIKE_MAX_OPEN = 3, SPIKE_RETRACE = 0.20;
const SPIKE_FEE_SAFETY = 2.5;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const CORE_INTERVAL_MS = 12 * 3600e3, CORE_FRAC = 0.05, CORE_MAX = 0.50;
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
const ceilingFor = (sp) => (sp * (1 - FEE)) / ((1 + FEE) * (1 + BTC_ACCUM_TARGET));

function simulate(candles, atr, opts = {}) {
  const useForecastTarget = !!opts.forecastTarget;
  const useSellLoop = opts.sellLoop !== false;

  let cash = START, btc = 0;
  let lots = [];              // {qty, price, sleeve, fcTarget}
  let orders = [];            // {target, amount, qtySold}
  let lastSell = null;        // {price, usd, qty}
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  const st = {
    coreBuys: 0, spikeSells: 0, spikeRebuys: 0, lockProfitSells: 0, stopSells: 0,
    signalBuys: 0, accumRebuys: 0, coinsFromCycles: 0, forecastSells: 0,
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
    const bearish = score <= THRESHOLDS.strongSell;
    const forecast = an.signal && an.signal.forecast;

    // ---- 1) คำสั่งรอราคา (รวมคำสั่งซื้อคืนจากไม้เขียวยาว) ----
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

    // ---- 2) ขายล็อกกำไร/ตัดขาดทุน (เฉพาะตอนคะแนนยืนยันขาลงชัดเจน) ----
    // ตรงกับ check-orders.mjs: ไล่หาไม้แรกที่เข้าเงื่อนไข ขายแล้ววนหาไม้ถัดไปในบาร์เดียวกัน (guard 30)
    let guard = 0, found = true;
    while (useSellLoop && found && guard < 30) {
      found = false; guard++;
      for (let k = 0; k < lots.length; k++) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        const stopLoss = l.price * (1 - STOP_LOSS_PCT);
        // lock_profit_bearish ถูกปิดถาวรแล้วในโค้ดจริง (ทำลายพอร์ตซ้ำรอย 2% เป้าเดิม) เหลือแค่ stop_loss
        let why = null;
        if (price <= stopLoss && bearish) why = "stop_loss";
        if (!why) continue;
        const amt = l.qty * price;
        if (amt < MIN_TICKET) continue;
        cash += amt * (1 - FEE); btc -= l.qty;
        lastSell = { price, usd: amt, qty: l.qty };
        lots.splice(k, 1);
        why === "stop_loss" ? st.stopSells++ : st.lockProfitSells++;
        found = true;
        break;
      }
    }

    // ---- [ใหม่] forecast target: ไม้ swing ถึงราคาเป้าหมาย (p90 แบบรี้ดขึ้นเรื่อยๆ) แล้วขายทั้งไม้ ----
    if (useForecastTarget && forecast && forecast.p90 > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        // รี้ดเป้าหมายขึ้นอย่างเดียว ไม่มีวันลดลง แม้ forecast รอบใหม่จะมองบวกน้อยลง
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

    // ---- 1b) ไม้เขียวยาว -> ขายรับรอบ 50% + ตั้งซื้อคืน ----
    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
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
        orders.push({
          target: price - SPIKE_RETRACE * body,
          amount: (gross * (1 - FEE)) / (1 + FEE),
          qtySold: sold,
        });
        st.spikeSells++;
      }
    }

    // ---- 2a) ขา core สะสมระยะยาว ----
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

    // ---- 2b) ซื้อคืนหลัง lock_profit/stop_loss/forecast target (รอราคาถึงเพดาน) ----
    if (lastSell && lastSell.qty > 0) {
      if (price > ceilingFor(lastSell.price)) continue;
      const amt = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (amt * (1 + FEE) <= cash && amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        const delta = q - lastSell.qty;
        st.coinsFromCycles += delta; st.accumRebuys++;
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
    valueVsHold: ((cash + btc * last) / last / holdCoins - 1) * 100,
    openOrders: orders.length,
    cashPct: cash / (cash + btc * last) * 100,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-5y.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}`);
console.log(`ราคา ${all[WARMUP].c.toFixed(0)} -> ${all[all.length - 1].c.toFixed(0)}\n`);

function report(name, r) {
  console.log(`\n### ${name}`);
  console.log(`  เหรียญที่ถือจริงตอนจบ ${r.btc.toFixed(8)} BTC  (เทียบซื้อทีเดียวถือยาว ${r.coinsVsHold >= 0 ? "+" : ""}${r.coinsVsHold.toFixed(2)}%)`);
  console.log(`  ในนั้นเป็นขา core ${r.coreCoins.toFixed(8)} BTC | เงินสดเหลือ $${r.cash.toFixed(2)} (${r.cashPct.toFixed(1)}%) | คำสั่งค้าง ${r.openOrders}`);
  console.log(`  กิจกรรม: core ${r.coreBuys} | ไม้ยาวขาย ${r.spikeSells} ซื้อคืน ${r.spikeRebuys} | ล็อกกำไร ${r.lockProfitSells} ตัดขาดทุน ${r.stopSells} | forecast target ขาย ${r.forecastSells} | ซื้อสัญญาณ ${r.signalBuys} | ซื้อคืนหลังขาย ${r.accumRebuys}`);
  console.log(`  เหรียญที่ได้เพิ่มจากการหมุนรอบ ${r.coinsFromCycles >= 0 ? "+" : ""}${r.coinsFromCycles.toFixed(8)} BTC`);
}

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance), min: Math.min(...arr), max: Math.max(...arr) };
}

// Monte Carlo forecast ใช้ Math.random() จริง (เหมือนของจริงที่ใช้งานสด) ทำให้แต่ละรอบรันได้คะแนน
// composite ต่างกันเล็กน้อย ซึ่งกระทบจังหวะ bearish/stop_loss ได้มาก — รันครั้งเดียวไม่พอจะสรุปผล
// ต้องรันหลายรอบแล้วดูค่าเฉลี่ย+ความแกว่ง ไม่งั้นอาจหลงเชื่อผลที่จริงๆ เป็นแค่สุ่มได้
const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี (Monte Carlo สุ่มจริงทุกรอบ) เพื่อดูค่าเฉลี่ย+ความแกว่ง\n`);

// baseline = โค้ดจริงปัจจุบัน (sell-loop เดิมปิดถาวรแล้ว ทั้ง lock_profit_bearish และ stop_loss)
const baseline = [], withTarget = [];
for (let t = 0; t < TRIALS; t++) {
  const rb = simulate(all, atr, { forecastTarget: false, sellLoop: false });
  const rt = simulate(all, atr, { forecastTarget: true, sellLoop: false });
  baseline.push(rb); withTarget.push(rt);
  console.log(`  รอบ ${t + 1}/${TRIALS}: baseline btc=${rb.btc.toFixed(8)} (${rb.coinsVsHold.toFixed(1)}%) | +forecast-target btc=${rt.btc.toFixed(8)} (${rt.coinsVsHold.toFixed(1)}%)`);
}

function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  const cycles = stats(runs.map((r) => r.coinsFromCycles));
  console.log(`\n### ${name} (n=${TRIALS})`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)} | ช่วง ${btc.min.toFixed(8)} - ${btc.max.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}% | ช่วง ${vsHold.min.toFixed(2)}% - ${vsHold.max.toFixed(2)}%`);
  console.log(`  เหรียญจากการหมุนรอบ: เฉลี่ย ${cycles.mean.toFixed(8)} | sd ${cycles.sd.toFixed(8)}`);
}

summarize("ปัจจุบัน (โค้ดจริง — sell-loop เดิมปิดถาวร, ไม่มี forecast target)", baseline);
summarize("เพิ่ม forecast target (p90 รี้ดขึ้น)", withTarget);
report("ตัวอย่างรอบสุดท้าย: baseline", baseline[baseline.length - 1]);
report("ตัวอย่างรอบสุดท้าย: forecast target", withTarget[withTarget.length - 1]);
