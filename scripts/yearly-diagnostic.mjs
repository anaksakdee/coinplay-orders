// วินิจฉัยว่าปีไหนที่ทำให้กลยุทธ์ (ไม้ยาว + core + forecast target, ไม่มี stop_loss) เสียเปรียบถือเฉยๆ
// สแนปช็อตจำนวน BTC ที่ถือ ณ ต้นปี/สิ้นปี เทียบกับ "ถ้าถือเฉยๆ" ของปีนั้นๆ เพื่อหาว่าปีไหนคือตัวฉุด
//
// รันเอง: node scripts/yearly-diagnostic.mjs [รอบทดสอบ]
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

function simulate(candles, atr) {
  let cash = START, btc = 0;
  let lots = [];
  let orders = [];
  let lastSell = null;
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  let lastYear = null;
  const yearSnaps = []; // { year, btc, coreCoins, swingCoins, cash, buys, sells }
  let buysThisYear = 0, sellsThisYear = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i], price = c.c;
    if (!a) continue;

    const y = new Date(c.t).getUTCFullYear();
    if (y !== lastYear) {
      if (lastYear !== null) {
        yearSnaps.push({
          year: lastYear, btc, cash,
          coreCoins: lots.filter((l) => l.sleeve === "core").reduce((s, l) => s + l.qty, 0),
          swingCoins: lots.filter((l) => l.sleeve !== "core").reduce((s, l) => s + l.qty, 0),
          buys: buysThisYear, sells: sellsThisYear,
        });
      }
      lastYear = y; buysThisYear = 0; sellsThisYear = 0;
    }

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
        buysThisYear++;
      }
      orders.splice(k, 1);
    }

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
          sellsThisYear++;
        }
      }
    }

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
        orders.push({ target: price - SPIKE_RETRACE * body, amount: (gross * (1 - FEE)) / (1 + FEE), qtySold: sold });
        sellsThisYear++;
      }
    }

    const coreLeft = START * CORE_MAX - coreSpent;
    if (c.t - lastCoreAt >= CORE_INTERVAL_MS && score > THRESHOLDS.strongSell && coreLeft >= MIN_TICKET) {
      const amt = Math.min(coreLeft, Math.max(MIN_TICKET, START * CORE_FRAC));
      if (amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "core", fcTarget: null });
        coreSpent += amt; lastCoreAt = c.t; buysThisYear++;
        continue;
      }
    }

    if (lastSell && lastSell.qty > 0) {
      if (price > ceilingFor(lastSell.price)) continue;
      const amt = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (amt * (1 + FEE) <= cash && amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        buysThisYear++;
      }
      lastSell = null;
      continue;
    }

    if (isSpike && body < 0 && score >= THRESHOLDS.weakBuy) {
      const frac = positionFraction(score, an.atrPct);
      const amt = cash * frac;
      if (amt >= MIN_TICKET && amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing", fcTarget: null });
        buysThisYear++;
      }
    }
  }
  yearSnaps.push({
    year: lastYear, btc, cash,
    coreCoins: lots.filter((l) => l.sleeve === "core").reduce((s, l) => s + l.qty, 0),
    swingCoins: lots.filter((l) => l.sleeve !== "core").reduce((s, l) => s + l.qty, 0),
    buys: buysThisYear, sells: sellsThisYear,
  });
  return yearSnaps;
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง | ทุน $${START}\n`);

// เทียบกับ "ถือเฉยๆ" — ราคาสิ้นปีของแต่ละปี ใช้คำนวณ btcIfHeld ตอนนั้น (ซื้อทีเดียวตอนต้น backtest ด้วยเงิน $300)
const startPrice = all[WARMUP].c;
const holdCoinsFixed = START / startPrice;

const TRIALS = Number(process.argv[2]) || 3;
const allRuns = [];
for (let t = 0; t < TRIALS; t++) allRuns.push(simulate(all, atr));

// เฉลี่ยข้าม trial ต่อปี (align ด้วย index เพราะทุก run มีปีเดียวกันตามลำดับเดียวกัน)
const years = allRuns[0].map((s) => s.year);
console.log("ปี | BTC ถือจริง (เฉลี่ย) | เทียบถือเฉยๆ | core | swing | ซื้อ/ขาย (เฉลี่ยต่อปี)");
for (let idx = 0; idx < years.length; idx++) {
  const snaps = allRuns.map((run) => run[idx]);
  const avgBtc = snaps.reduce((a, s) => a + s.btc, 0) / snaps.length;
  const avgCore = snaps.reduce((a, s) => a + s.coreCoins, 0) / snaps.length;
  const avgSwing = snaps.reduce((a, s) => a + s.swingCoins, 0) / snaps.length;
  const avgBuys = snaps.reduce((a, s) => a + s.buys, 0) / snaps.length;
  const avgSells = snaps.reduce((a, s) => a + s.sells, 0) / snaps.length;
  const vsHold = (avgBtc / holdCoinsFixed - 1) * 100;
  console.log(`${years[idx]} | ${avgBtc.toFixed(8)} | ${vsHold >= 0 ? "+" : ""}${vsHold.toFixed(1)}% | ${avgCore.toFixed(8)} | ${avgSwing.toFixed(8)} | ${avgBuys.toFixed(0)}/${avgSells.toFixed(0)}`);
}
