// เทียบ "กำไรจริง" (จำนวน BTC ที่ได้) ของกลยุทธ์ไม้ยาว+core+forecast-target บน 3 ไทม์เฟรม: 1 ชม. / 3 วัน / 1 สัปดาห์
// ใช้ตรรกะเดียวกับ scripts/multislot-rebuy-test.mjs (โค้ดจริงปัจจุบันหลังแก้คิวหลายช่อง) เป๊ะ
// เปลี่ยนแค่ชุดแท่งเทียนที่ป้อนเข้าไป (resample จาก 1 ชม. ขึ้นเป็นแท่งใหญ่) และพารามิเตอร์เวลาที่ต้อง
// ปรับสเกลตามความถี่แท่ง (WARMUP/LEARN_EVERY/SCORE_WINDOW) — เกณฑ์ไม้ยาว (ATR/body%) ไม่ต้องปรับเพราะ
// คำนวณจากข้อมูลไทม์เฟรมนั้นเองอยู่แล้ว
//
// คำเตือนความไม่เท่าเทียม: อินดิเคเตอร์ (RSI/MACD/ฯลฯ) ถูก calibrate มาสำหรับสัญญาณรายชั่วโมงเดิม
// เอาไปรันบนแท่งใหญ่กว่าด้วยพารามิเตอร์ที่ปรับเอง อาจไม่ใช่การเปรียบเทียบที่ยุติธรรม 100% แต่พอให้เห็นทิศทาง
//
// รันเอง: node scripts/timeframe-profit-test.mjs [รอบทดสอบ]
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
const FORECAST_MAX_OPEN = 3;

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

function resample(hourly, bucketKeyFn) {
  const buckets = new Map();
  for (const c of hourly) {
    const key = bucketKeyFn(c.t);
    let b = buckets.get(key);
    if (!b) buckets.set(key, { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; b.v += c.v || 0; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}
const DAY = 86400e3;
const bucket3Day = (t) => Math.floor(t / (3 * DAY));
const bucketWeek = (t) => Math.floor(t / (7 * DAY));

// tf: { warmup, learnEvery, scoreWindow }
function simulate(candles, atr, tf) {
  const { warmup, learnEvery, scoreWindow } = tf;
  let cash = START, btc = 0;
  let lots = [];
  let orders = [];
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  const st = { coreBuys: 0, spikeSells: 0, spikeRebuys: 0, signalBuys: 0, forecastSells: 0, forecastRebuys: 0, coinsFromCycles: 0 };

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;
    if (i % learnEvery === 0 || !learned) {
      const w = candles.slice(Math.max(0, i - Math.max(60, scoreWindow * 3)), i + 1);
      learned = evaluateIndicators(w, Math.min(20, Math.floor(w.length / 3) || 1), Math.min(60, w.length)) || learned;
    }
    const win = candles.slice(Math.max(0, i - scoreWindow), i + 1);
    const an = scoreMarket(price, win, computeReturns(win), learned);
    const score = an.composite;
    if (!Number.isFinite(score)) continue;
    const forecast = an.signal && an.signal.forecast;

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

    if (forecast && forecast.p90 > 0) {
      for (let k = lots.length - 1; k >= 0; k--) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        l.fcTarget = l.fcTarget == null ? forecast.p90 : Math.max(l.fcTarget, forecast.p90);
        const netPnlPct = (price * (1 - FEE) / (l.price * (1 + FEE)) - 1) * 100;
        if (!(price >= l.fcTarget && netPnlPct > 0)) continue;
        const openForecast = orders.filter((o) => o.forecast).length;
        if (openForecast >= FORECAST_MAX_OPEN) continue;
        const amt = l.qty * price;
        if (amt < MIN_TICKET) continue;
        cash += amt * (1 - FEE); btc -= l.qty;
        lots.splice(k, 1);
        st.forecastSells++;
        orders.push({ target: ceilingFor(price), amount: (amt * (1 - FEE)) / (1 + FEE), qtySold: l.qty, forecast: true });
      }
    }

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
  const holdCoins = START / candles[warmup].c;
  return {
    ...st, cash, btc,
    coreCoins: lots.filter((l) => l.sleeve === "core").reduce((s, l) => s + l.qty, 0),
    coinsVsHold: (btc / holdCoins - 1) * 100,
  };
}

const hourly = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));

const TIMEFRAMES = [
  { label: "1 ชม. (ของเดิม)", candles: hourly, tf: { warmup: 300, learnEvery: 1000, scoreWindow: 300 } },
  { label: "3 วัน", candles: resample(hourly, bucket3Day), tf: { warmup: 30, learnEvery: 30, scoreWindow: 100 } },
  { label: "1 สัปดาห์", candles: resample(hourly, bucketWeek), tf: { warmup: 20, learnEvery: 15, scoreWindow: 52 } },
];

console.log(`ข้อมูลต้นทาง 1h ${hourly.length} แท่ง = ${((hourly[hourly.length - 1].t - hourly[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}`);
console.log("คำเตือน: อินดิเคเตอร์ calibrate มาสำหรับสัญญาณรายชั่วโมง เทียบข้ามไทม์เฟรมนี้เพื่อดูทิศทางกว้างๆ ไม่ใช่ตัวเลขที่แม่นยำเป๊ะ 100%\n");

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

const TRIALS = Number(process.argv[2]) || 5;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อไทม์เฟรม (Monte Carlo สุ่มจริง)\n`);

for (const { label, candles, tf } of TIMEFRAMES) {
  if (candles.length <= tf.warmup + 20) {
    console.log(`### ${label}: ข้อมูลไม่พอ (${candles.length} แท่ง, warmup ${tf.warmup}) ข้าม`);
    continue;
  }
  const atr = atrSeries(candles, 14);
  const runs = [];
  for (let t = 0; t < TRIALS; t++) runs.push(simulate(candles, atr, tf));
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  const fSells = stats(runs.map((r) => r.forecastSells));
  const sSells = stats(runs.map((r) => r.spikeSells));
  const sBuys = stats(runs.map((r) => r.signalBuys));
  console.log(`\n### ${label} (${candles.length} แท่ง, n=${TRIALS} รอบ)`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
  console.log(`  กิจกรรม: ไม้เขียวขาย ${sSells.mean.toFixed(1)} | forecast ขาย ${fSells.mean.toFixed(1)} | ไม้แดงซื้อ ${sBuys.mean.toFixed(1)}`);
}
