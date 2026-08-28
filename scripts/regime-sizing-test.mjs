// ทดสอบ "ปรับขนาดไม้ตามสถานะตลาด" (bull/bear/sideways) — เพิ่มจากกลยุทธ์ที่ผ่าน backtest แล้ว (ไม่แทนที่)
// สถานะตลาดคำนวณจากผลตอบแทนย้อนหลัง 90 วัน (เกณฑ์เดียวกับ scripts/spike-pattern-analysis.mjs มุมที่ 5)
// ซึ่งพบว่า "ขาลง" คือช่วงที่ไม้ยาวเกิดถี่สุด (11.57/1000ชม.) และ "ไซด์เวย์" เกิดน้อยสุด (5.11/1000ชม.)
// สมมติฐาน: ถ้าโอกาสมีมากกว่าในขาลง ควรลงเงินต่อไม้มากขึ้นในช่วงนั้น และลดขนาดไม้ลงตอนไซด์เวย์ที่โอกาสน้อย
//
// รันเอง: node scripts/regime-sizing-test.mjs [รอบทดสอบ]
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
const CORE_INTERVAL_MS = 12 * 3600e3; // ไม่ได้ใช้แล้ว (core_dca ถอดออกแล้ว) เหลือไว้เผื่ออ้างอิง
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;
const FORECAST_MAX_OPEN = 3;
const REGIME_WINDOW_H = 90 * 24;
const REGIME_THRESHOLD = 0.20;

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

function regimeSeries(candles) {
  const regimes = new Array(candles.length).fill("sideways");
  for (let i = 0; i < candles.length; i++) {
    const j = i - REGIME_WINDOW_H;
    if (j < 0) continue;
    const ret = candles[i].c / candles[j].c - 1;
    regimes[i] = ret > REGIME_THRESHOLD ? "bull" : ret < -REGIME_THRESHOLD ? "bear" : "sideways";
  }
  return regimes;
}

// opts.regimeMult = { bull, bear, sideways } ตัวคูณ minFrac/maxFrac ของ positionFraction — ไม่ใส่ = ไม่ปรับ (1.0 ทุกอัน)
function simulate(candles, atr, regimes, opts = {}) {
  const mult = opts.regimeMult || { bull: 1, bear: 1, sideways: 1 };
  let cash = START, btc = 0;
  let lots = [];
  let orders = [];
  let learned = null;
  const st = { spikeSells: 0, spikeRebuys: 0, signalBuys: 0, forecastSells: 0, forecastRebuys: 0, coinsFromCycles: 0 };

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

    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy) {
      const regime = regimes[i];
      const m = mult[regime] || 1;
      const frac = positionFraction(score, an.atrPct, 0.15 * m, 0.6 * m);
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
  return { ...st, cash, btc, coinsVsHold: (btc / holdCoins - 1) * 100 };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
const regimes = regimeSeries(all);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START}\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}
function summarize(name, runs) {
  const btc = stats(runs.map((r) => r.btc));
  const vsHold = stats(runs.map((r) => r.coinsVsHold));
  console.log(`\n### ${name} (n=${runs.length})`);
  console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
  console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบต่อกรณี\n`);

const flat = [], regimeAware = [];
const REGIME_MULT = { bull: 1.0, bear: 1.3, sideways: 0.8 };
for (let t = 0; t < TRIALS; t++) {
  const rf = simulate(all, atr, regimes, { regimeMult: { bull: 1, bear: 1, sideways: 1 } });
  const rr = simulate(all, atr, regimes, { regimeMult: REGIME_MULT });
  flat.push(rf); regimeAware.push(rr);
  console.log(`  รอบ ${t + 1}/${TRIALS}: คงที่ btc=${rf.btc.toFixed(8)} (${rf.coinsVsHold.toFixed(1)}%) | ปรับตาม regime btc=${rr.btc.toFixed(8)} (${rr.coinsVsHold.toFixed(1)}%)`);
}

summarize("ขนาดไม้คงที่ (ของเดิม)", flat);
summarize(`ปรับตาม regime (ขาลงx${REGIME_MULT.bear}, ไซด์เวย์x${REGIME_MULT.sideways})`, regimeAware);
