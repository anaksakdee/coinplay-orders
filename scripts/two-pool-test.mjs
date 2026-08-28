// ทดสอบไอเดียล่าสุด: แบ่งทุนเป็น 2 ก้อน ก้อนละ 50% แต่ละก้อนบริหารอิสระตามแผนเดียวกัน
// (ซื้อไม้แดงยาวตอนขาลง จดจำราคาที่ซื้อ ขายเมื่อกำไร 2% คงที่ แล้วรอไม้แดงยาวรอบใหม่ค่อยซื้ออีก)
// จุดต่างจาก fixed-target-test.mjs (คิวรวมสูงสุด 3 ช่อง ใช้เงินทั้งก้อนตาม positionFraction):
// ที่นี่แบ่งเป็น 2 บัญชีย่อยอิสระจริงๆ ก้อนละ $150 แต่ละก้อนถือได้ทีละ 1 โพซิชัน ใช้เงินทั้งก้อนย่อยเวลาซื้อ
// เป้าหมาย: ให้มีไม้เปิดพร้อมกันได้สูงสุด 2 ไม้เสมอ (ไม่ใช่ 0-3 แบบสุ่มตามคิว) และแต่ละไม้ขนาดใหญ่ขึ้น (50% ของทุนรวม)
//
// รันเอง: node scripts/two-pool-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const POOL_START = START / 2; // $150 ต่อก้อน
const MIN_TICKET = 5;
const SPIKE_ATR_MULT = 1.5;
const SPIKE_FEE_SAFETY = 2.5, SPIKE_RETRACE = 0.20;
const SPIKE_MIN_BODY = (SPIKE_FEE_SAFETY * (2 * FEE * 100)) / SPIKE_RETRACE;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;
const PROFIT_TARGET = 0.02;

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

// pool = { cash, btc, lot: {qty, price} | null }  — ถือได้ทีละ 1 ไม้ต่อก้อน
function simulate(candles, atr) {
  const pools = [{ cash: POOL_START, btc: 0, lot: null }, { cash: POOL_START, btc: 0, lot: null }];
  let learned = null;
  const st = { buys: 0, sells: 0 };

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
    const isRedLong = isSpike && body < 0 && score >= THRESHOLDS.weakBuy;

    for (const pool of pools) {
      // ---- ขายถ้าไม้ที่ถืออยู่กำไรถึง 2% ----
      if (pool.lot) {
        const netPnlPct = (price * (1 - FEE) / (pool.lot.price * (1 + FEE)) - 1) * 100;
        if (netPnlPct >= PROFIT_TARGET * 100) {
          const amt = pool.lot.qty * price;
          pool.cash += amt * (1 - FEE);
          pool.btc -= pool.lot.qty;
          pool.lot = null;
          st.sells++;
        }
      }
      // ---- ซื้อถ้าไม่มีไม้ค้าง + เจอไม้แดงยาว ----
      if (!pool.lot && isRedLong && pool.cash >= MIN_TICKET) {
        const amt = pool.cash; // ทุ่มเงินทั้งก้อนย่อย (50% ของทุนรวม)
        const q = amt / price;
        pool.btc += q; pool.cash -= amt * (1 + FEE);
        pool.lot = { qty: q, price };
        st.buys++;
      }
    }
  }

  const last = candles[candles.length - 1].c;
  const btc = pools.reduce((s, p) => s + p.btc, 0);
  const cash = pools.reduce((s, p) => s + p.cash, 0);
  const holdCoins = START / candles[WARMUP].c;
  const equity = cash + btc * last;
  const holdEquity = holdCoins * last; // มูลค่าถ้าซื้อทีเดียวตั้งแต่ต้นแล้วถือเฉยๆ ไม่ขาย
  return {
    ...st, cash, btc, equity, holdEquity,
    coinsVsHold: (btc / holdCoins - 1) * 100,
    equityVsHold: (equity / holdEquity - 1) * 100,
    openLots: pools.filter((p) => p.lot).length,
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-10y-vol.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length - 1].t - all[0].t) / 86400e3 / 365).toFixed(1)} ปี | ทุน $${START} (แบ่ง 2 ก้อน $${POOL_START} ต่อก้อน)\n`);

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบ (คะแนน score ยังรวม Monte Carlo forecast เป็นหนึ่งในอินดิเคเตอร์ถ่วงน้ำหนักอยู่ จึงยังสุ่มเล็กน้อย รันหลายรอบเพื่อดูค่าเฉลี่ย)\n`);

const runs = [];
for (let t = 0; t < TRIALS; t++) {
  const r = simulate(all, atr);
  runs.push(r);
  console.log(`  รอบ ${t + 1}/${TRIALS}: btc=${r.btc.toFixed(8)} (${r.coinsVsHold.toFixed(1)}%) | equity $${r.equity.toFixed(2)} เทียบถือ $${r.holdEquity.toFixed(2)} (${r.equityVsHold >= 0 ? "+" : ""}${r.equityVsHold.toFixed(1)}%) | ซื้อ ${r.buys} | ขาย ${r.sells}`);
}

const btc = stats(runs.map((r) => r.btc));
const vsHold = stats(runs.map((r) => r.coinsVsHold));
const eq = stats(runs.map((r) => r.equity));
const eqVsHold = stats(runs.map((r) => r.equityVsHold));
console.log(`\n### สรุป (n=${TRIALS})`);
console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)} (0 ปกติถ้าจบตอนพอร์ตถือเงินสดรออยู่ ไม่ใช่ระบบพัง)`);
console.log(`  เทียบถือยาว (จำนวนเหรียญ): เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
console.log(`  Equity ($): เฉลี่ย $${eq.mean.toFixed(2)} | sd $${eq.sd.toFixed(2)}`);
console.log(`  เทียบถือยาว (มูลค่าเงิน): เฉลี่ย ${eqVsHold.mean >= 0 ? "+" : ""}${eqVsHold.mean.toFixed(2)}% | sd ${eqVsHold.sd.toFixed(2)}%`);
