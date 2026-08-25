// ทดสอบ "ทั้งระบบรันพร้อมกัน" บนข้อมูลจริง 5 ปี
// จำลองทุกกลไกตามลำดับเดียวกับ scripts/check-orders.mjs ของจริง:
//   1) คำสั่งรอราคาที่ตั้งไว้ (orders)  2) ขายทำกำไร/ตัดขาดทุน  3) ไม้เขียวยาว -> ขายรับรอบ
//   4) ขา core สะสม  5) ด่านรอซื้อคืน (lastSell)  6) ขา swing ซื้อตามสัญญาณ
//
// ข้อจำกัดที่ต้องรู้: ของจริงคิดคะแนนสัญญาณจากแท่ง 1 นาที แต่ทดสอบนี้มีแค่แท่ง 1 ชม.
// (5 ปีของแท่ง 1 นาที = 2.6 ล้านแท่ง ต้องยิง API ~2,600 ครั้ง) คะแนนจึงสะท้อนโครงสร้างที่ยาวกว่าของจริง
// ส่วนการหาไม้ยาวใช้แท่ง 1 ชม. ซึ่งตรงกับของจริงเป๊ะ
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const MIN_TICKET = 5;
const PROFIT_TARGET = 0.02;
const STOP_LOSS_PCT = 0.05;
const BTC_ACCUM_TARGET = 0.0025;
const SPIKE_ATR_MULT = 1.5, SPIKE_PCT = 0.50, SPIKE_MAX_OPEN = 3, SPIKE_RETRACE = 0.20;
const SPIKE_MIN_BODY = (2.5 * (2 * FEE * 100)) / SPIKE_RETRACE;   // = 2.5%
const CORE_INTERVAL_MS = 12 * 3600e3, CORE_FRAC = 0.05, CORE_MAX = 0.50;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;

function atrSeries(c, p = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i-1].c), Math.abs(c[i].l - c[i-1].c)));
  const o = new Array(c.length).fill(null);
  if (c.length <= p) return o;
  let v = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p;
  o[p] = v;
  for (let i = p + 1; i < c.length; i++) { v = (v * (p - 1) + tr[i]) / p; o[i] = v; }
  return o;
}
const ceilingFor = (sp) => (sp * (1 - FEE)) / ((1 + FEE) * (1 + BTC_ACCUM_TARGET));

function simulate(candles, atr, opts = {}) {
  const useCore = opts.core !== false;
  const useSpike = opts.spike !== false;
  const useProfitSell = opts.profitSell !== false;
  const useStopLoss = opts.stopLoss !== false;
  const useSignalBuy = opts.signalBuy !== false;

  let cash = START, btc = 0;
  let lots = [];              // {qty, price, sleeve}
  let orders = [];            // {target, amount, qtySold}
  let lastSell = null;        // {price, usd, qty}
  let lastCoreAt = -Infinity, coreSpent = 0;
  let learned = null;
  const st = { coreBuys: 0, spikeSells: 0, spikeRebuys: 0, profitSells: 0, stopSells: 0, signalBuys: 0, accumRebuys: 0, coinsFromCycles: 0 };

  // เริ่มด้วยเงินสดล้วน เหมือนผู้ใช้เปิดบัญชีใหม่
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

    // ---- 1) คำสั่งรอราคา (ใช้ low ของแท่ง เพราะราคาแตะระหว่างแท่งก็โดน) ----
    for (let k = orders.length - 1; k >= 0; k--) {
      const o = orders[k];
      if (c.l > o.target) continue;
      const need = o.amount * (1 + FEE);
      if (need <= cash && o.amount >= MIN_TICKET) {
        const q = o.amount / o.target;
        btc += q; cash -= need;
        lots.push({ qty: q, price: o.target, sleeve: "swing" });
        st.spikeRebuys++; st.coinsFromCycles += q - o.qtySold;
      }
      orders.splice(k, 1);
    }

    // ---- 2) ขายทำกำไร 2% / ตัดขาดทุน 5% (เฉพาะไม้ swing) ----
    if (useProfitSell) {
      for (let k = 0; k < lots.length; k++) {
        const l = lots[k];
        if (l.sleeve === "core") continue;
        const tgt = l.price * (1 + PROFIT_TARGET) / (1 - FEE);
        const stop = l.price * (1 - STOP_LOSS_PCT);
        const hitT = price >= tgt, hitS = useStopLoss && !hitT && bearish && price <= stop;
        if (!hitT && !hitS) continue;
        const amt = l.qty * price;
        if (amt < MIN_TICKET) continue;
        cash += amt * (1 - FEE); btc -= l.qty;
        lastSell = { price, usd: amt, qty: l.qty };
        lots.splice(k, 1);
        hitT ? st.profitSells++ : st.stopSells++;
        break;
      }
    }

    // ---- 3) ไม้เขียวยาว -> ขายรับรอบ + ตั้งซื้อคืน (สูงสุด 3 รอบพร้อมกัน) ----
    const body = c.c - c.o, bodyPct = Math.abs(body) / price * 100;
    const isSpike = Math.abs(body) > SPIKE_ATR_MULT * a && bodyPct >= SPIKE_MIN_BODY;
    if (useSpike && isSpike && body > 0 && orders.length < SPIKE_MAX_OPEN) {
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

    // ---- 4) ขา core (มาก่อนด่านรอซื้อคืน ตามที่แก้ไว้) ----
    const coreLeft = START * CORE_MAX - coreSpent;
    if (useCore && c.t - lastCoreAt >= CORE_INTERVAL_MS && score > THRESHOLDS.strongSell && coreLeft >= MIN_TICKET) {
      const amt = Math.min(coreLeft, Math.max(MIN_TICKET, START * CORE_FRAC));
      if (amt * (1 + FEE) <= cash) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "core" });
        coreSpent += amt; lastCoreAt = c.t; st.coreBuys++;
        continue;
      }
    }

    // ---- 5) ด่านรอซื้อคืนจากการขายทำกำไร ----
    if (lastSell && lastSell.qty > 0) {
      if (price > ceilingFor(lastSell.price)) continue;   // ยังแพงไป ถือเงินสดรอ
      const amt = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (amt * (1 + FEE) <= cash && amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        lots.push({ qty: q, price, sleeve: "swing" });
        st.coinsFromCycles += q - lastSell.qty; st.accumRebuys++;
      }
      lastSell = null;
      continue;
    }

    // ---- 6) ขา swing ซื้อตามสัญญาณ (เฉพาะไม้แดงยาว + คะแนนถึงเกณฑ์) ----
    if (useSignalBuy && isSpike && body < 0 && score >= THRESHOLDS.weakBuy) {
      const frac = Math.min(0.25, 0.15 + Math.max(0, (score - THRESHOLDS.weakBuy) / 100) * 0.3);
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
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length-1].t-all[0].t)/86400e3/365).toFixed(1)} ปี | ทุน $${START}`);
console.log(`ราคา ${all[WARMUP].c.toFixed(0)} -> ${all[all.length-1].c.toFixed(0)}\n`);

const CASES = [
  { n: "ระบบหลังแก้ (ตัดขายกำไร 2% ออก คงตัดขาดทุน)", o: { profitSell: false, stopLoss: true } },
];

console.log("=".repeat(100));
for (const cs of CASES) {
  const r = simulate(all, atr, cs.o);
  console.log(`\n### ${cs.n}`);
  console.log(`  เหรียญที่ถือจริงตอนจบ ${r.btc.toFixed(8)} BTC  (เทียบซื้อทีเดียวถือยาว ${r.coinsVsHold >= 0 ? "+" : ""}${r.coinsVsHold.toFixed(2)}%)`);
  console.log(`  ในนั้นเป็นขา core ${r.coreCoins.toFixed(8)} BTC | เงินสดเหลือ $${r.cash.toFixed(2)} (${r.cashPct.toFixed(1)}% ของพอร์ต) | คำสั่งค้าง ${r.openOrders}`);
  console.log(`  กิจกรรม: core ${r.coreBuys} | ไม้ยาวขาย ${r.spikeSells} ซื้อคืน ${r.spikeRebuys} | ขายกำไร ${r.profitSells} ตัดขาดทุน ${r.stopSells} | ซื้อสัญญาณ ${r.signalBuys} | ซื้อคืนหลังขายกำไร ${r.accumRebuys}`);
  console.log(`  เหรียญที่ได้เพิ่มจากการหมุนรอบ ${r.coinsFromCycles >= 0 ? "+" : ""}${r.coinsFromCycles.toFixed(8)} BTC`);
}
