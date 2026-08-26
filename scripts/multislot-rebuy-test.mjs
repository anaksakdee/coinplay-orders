// ทดสอบแก้จุดอ่อนเชิงโครงสร้าง: "lastSell" ช่องเดียวทำให้ระบบค้างรอราคาย่อกลับตอนตลาดขาขึ้นแรงต่อเนื่อง
// (พบจาก scripts/yearly-diagnostic.mjs — swing coins หายไป ~45% ในปี 2020 ซึ่งเป็นปีกระทิงแรงสุด)
//
// แก้โดยเปลี่ยน forecast-target sell ให้ตั้งคำสั่งซื้อคืนแบบ "คิวหลายช่อง" เหมือนกลไกไม้เขียวยาว
// (orders[] รองรับพร้อมกันได้หลายรอบ) แทนที่จะใช้ lastSell ช่องเดียว — ทำให้ระบบซื้อไม้ใหม่ตามสัญญาณอื่น
// ต่อได้แม้มีรอบรอซื้อคืนค้างอยู่ ไม่ต้องหยุดรอทั้งระบบเพราะรอบเดียว
//
// รันเอง: node scripts/multislot-rebuy-test.mjs [รอบทดสอบ]
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
const FORECAST_MAX_OPEN = 3; // เดียวกับ SPIKE_MAX_OPEN ที่ผ่าน backtest มาแล้ว

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

// useQueue=false -> ของเดิม (lastSell ช่องเดียว) | useQueue=true -> คิวหลายช่อง (การแก้ใหม่)
function simulate(candles, atr, opts = {}) {
  const useQueue = !!opts.queue;

  let cash = START, btc = 0;
  let lots = [];
  let orders = [];        // {target, amount, qtySold, forecast?:true}
  let lastSell = null;    // ใช้เฉพาะโหมดเดิม (useQueue=false)
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  const st = {
    coreBuys: 0, spikeSells: 0, spikeRebuys: 0,
    signalBuys: 0, accumRebuys: 0, coinsFromCycles: 0, forecastSells: 0, forecastRebuys: 0,
    blockedByLastSell: 0,
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

    // ---- 1) คำสั่งรอราคา (รวมคำสั่งซื้อคืนจากไม้เขียวยาว + forecast-target แบบคิว) ----
    for (let k = orders.length - 1; k >= 0; k--) {
      const o = orders[k];
      if (c.l > o.target) continue;
      const need = o.amount * (1 + FEE);
      if (need <= cash && o.amount >= MIN_TICKET) {
        const q = o.amount / o.target;
        btc += q; cash -= need;
        lots.push({ qty: q, price: o.target, sleeve: "swing", fcTarget: null });
        st.coinsFromCycles += q - o.qtySold;
        if (o.forecast) st.forecastRebuys++; else st.spikeRebuys++;
      }
      orders.splice(k, 1);
    }

    // ---- forecast target: ไม้ swing ถึงราคาเป้าหมาย (p90 รี้ดขึ้น) แล้วขายทั้งไม้ ----
    if (forecast && forecast.p90 > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        l.fcTarget = l.fcTarget == null ? forecast.p90 : Math.max(l.fcTarget, forecast.p90);
        const netPnlPct = (price * (1 - FEE) / (l.price * (1 + FEE)) - 1) * 100;
        if (!(price >= l.fcTarget && netPnlPct > 0)) continue;

        if (useQueue) {
          const openForecast = orders.filter((o) => o.forecast).length;
          if (openForecast >= FORECAST_MAX_OPEN) continue; // คิวเต็ม รอรอบหน้า ไม่บล็อกทั้งระบบ
        } else if (lastSell && lastSell.qty > 0) {
          continue; // โหมดเดิม: มีรอบค้างอยู่แล้ว ขายไม้ใหม่ไม่ได้จนกว่าจะซื้อคืนสำเร็จ
        }

        const amt = l.qty * price;
        if (amt < MIN_TICKET) continue;
        cash += amt * (1 - FEE); btc -= l.qty;
        lots.splice(k, 1);
        st.forecastSells++;

        if (useQueue) {
          const ceiling = ceilingFor(price);
          orders.push({ target: ceiling, amount: (amt * (1 - FEE)) / (1 + FEE), qtySold: l.qty, forecast: true });
        } else {
          lastSell = { price, usd: amt, qty: l.qty };
        }
      }
    }

    // ---- ไม้เขียวยาว -> ขายรับรอบ 50% + ตั้งซื้อคืน (คิวเดิม ไม่เปลี่ยน) ----
    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    if (isSpike && body > 0 && orders.filter((o) => !o.forecast).length < SPIKE_MAX_OPEN) {
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

    // ---- ขา core ----
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

    // ---- ซื้อคืนหลังขาย (โหมดเดิมเท่านั้น — lastSell ช่องเดียว) ----
    if (!useQueue && lastSell && lastSell.qty > 0) {
      st.blockedByLastSell++;
      if (price > ceilingFor(lastSell.price)) continue;
      const amt = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (amt * (1 + FEE) <= cash && amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        st.coinsFromCycles += q - lastSell.qty; st.forecastRebuys++;
      }
      lastSell = null;
      continue;
    }

    // ---- ซื้อไม้แดงยาวตามสัญญาณ ----
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
    swingCoins: lots.filter((l) => l.sleeve !== "core").reduce((s, l) => s + l.qty, 0),
    coinsVsHold: (btc / holdCoins - 1) * 100,
    openOrders: orders.length,
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
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  const swing = stats(runs.map((r) => r.swingCoins));
  const fSells = stats(runs.map((r) => r.forecastSells));
  const fRebuys = stats(runs.map((r) => r.forecastRebuys));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
  console.log(`  swing coins: เฉลี่ย ${swing.mean.toFixed(8)}`);
  console.log(`  forecast ขาย ${fSells.mean.toFixed(1)} ครั้ง | ซื้อคืนสำเร็จ ${fRebuys.mean.toFixed(1)} ครั้ง (${(fRebuys.mean / Math.max(1, fSells.mean) * 100).toFixed(0)}% ปิดรอบได้)`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const single = [], queue = [];
for (let t = 0; t < TRIALS; t++) {
  const rs = simulate(all, atr, { queue: false });
  const rq = simulate(all, atr, { queue: true });
  single.push(rs); queue.push(rq);
  console.log(`  รอบ ${t + 1}/${TRIALS}: lastSell เดิม btc=${rs.btc.toFixed(8)} (${rs.coinsVsHold.toFixed(1)}%) | คิวหลายช่อง btc=${rq.btc.toFixed(8)} (${rq.coinsVsHold.toFixed(1)}%)`);
}

summarize("lastSell ช่องเดียว (ของเดิม)", single);
summarize("คิวหลายช่อง (การแก้ใหม่)", queue);
