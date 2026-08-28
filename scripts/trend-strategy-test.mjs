// กลยุทธ์โครงสร้างใหม่ทั้งหมด: "Trend-Following Accumulation" แทนที่ mean-reversion (spike-fade) เดิม
//
// สมมติฐานที่มาจากผลทดสอบก่อนหน้า: กลยุทธ์เดิมแพ้ถือเฉยๆ เพราะ "ขายทำกำไรเร็วเกินไประหว่างขาขึ้นยาว"
// (ปี 2020-2021 บวก 300%+ แต่ swing coins หายไปครึ่งนึง) — เป็นปัญหาเชิงโครงสร้างของ mean-reversion
// ที่ขายเมื่อราคาขึ้น/ซื้อเมื่อราคาลง ซึ่งสู้เทรนด์แรงๆ ไม่ได้
//
// กลยุทธ์ใหม่: "ตามเทรนด์" แทน — ซื้อตอนเทรนด์ขึ้นชัดเจน ถือยาวตลอดขาขึ้น ขายออกเฉพาะตอน regime
// เปลี่ยนเป็นขาลงชัดเจนเท่านั้น (ไม่ขายทุกครั้งที่ราคาขึ้นแรงเหมือนเดิม) แล้วซื้อกลับตอน regime ฟื้น
// ไม่มีขา core แยก ไม่มีการเติมเงินใหม่ ใช้ทุนก้อนเดียวจากต้นจนจบ
//
// รันเอง: node scripts/trend-strategy-test.mjs [รอบทดสอบ]
import { readFileSync } from "fs";
import { scoreMarket, THRESHOLDS, positionFraction } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;
const START = 300;
const MIN_TICKET = 5;
const WARMUP = 300, LEARN_EVERY = 1000, SCORE_WINDOW = 300;
const REGIME_WINDOW_H = 90 * 24;
const REGIME_THRESHOLD = 0.20;
const BEAR_SELL_FRAC = 0.30; // ขายออก 30% ตอนยืนยันเข้าขาลง (ไม่ขายหมด กันพลาดถ้าเด้งกลับเร็ว)

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

function simulate(candles, atr, regimes) {
  let cash = START, btc = 0;
  let inBear = false; // สถานะปัจจุบัน กันขายซ้ำทุกแท่งตอนเข้าขาลงรอบเดียวกัน
  let learned = null;
  const st = { trendBuys: 0, bearSells: 0, recoveryBuys: 0 };

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
    const trendUp = an.signal && an.signal.trendUp; // EMA9 > EMA21
    const regime = regimes[i];

    // ---- ยืนยันเข้าขาลง: ขายออกบางส่วนเก็บเป็นเงินสด (ครั้งเดียวตอนเพิ่งเข้า ไม่ขายซ้ำทุกแท่ง) ----
    if (regime === "bear" && !inBear && btc > 0) {
      inBear = true;
      const sellQty = btc * BEAR_SELL_FRAC;
      const amt = sellQty * price;
      if (amt >= MIN_TICKET) {
        btc -= sellQty; cash += amt * (1 - FEE);
        st.bearSells++;
      }
    } else if (regime !== "bear" && inBear) {
      inBear = false; // ออกจากขาลงแล้ว กลับสู่โหมดซื้อตามเทรนด์ปกติ
    }

    // ---- ซื้อตามเทรนด์: เทรนด์ขึ้นชัดเจน + คะแนนไม่ลบ + ไม่ได้อยู่ระหว่างขาลงยืนยัน ----
    if (!inBear && trendUp && score >= 0 && cash > MIN_TICKET) {
      const frac = positionFraction(Math.max(score, THRESHOLDS.weakBuy), an.atrPct); // ใช้สูตรเดิมคำนวณขนาดไม้
      const amt = cash * frac;
      if (amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        st.trendBuys++;
      }
    }

    // ---- ซื้อกลับหลังฟื้นจากขาลง: ใช้เงินสดที่เก็บไว้ตอนขาย ทยอยซื้อกลับตอนกลับมาเป็นขาขึ้น ----
    if (!inBear && regime === "bull" && trendUp && cash > MIN_TICKET && st.bearSells > st.recoveryBuys) {
      const amt = Math.min(cash, cash * 0.5); // ทยอยซื้อกลับครึ่งนึงของเงินสดที่เหลือต่อรอบ ไม่ทุ่มหมดทีเดียว
      if (amt >= MIN_TICKET) {
        const q = amt / price;
        btc += q; cash -= amt * (1 + FEE);
        st.recoveryBuys++;
      }
    }
  }

  const last = candles[candles.length - 1].c;
  const holdCoins = START / candles[WARMUP].c;
  return { ...st, cash, btc, coinsVsHold: (btc / holdCoins - 1) * 100, equity: cash + btc * last };
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

const TRIALS = Number(process.argv[2]) || 8;
console.log("=".repeat(100));
console.log(`รัน ${TRIALS} รอบ (กลยุทธ์ trend-following ใหม่)\n`);

const runs = [];
for (let t = 0; t < TRIALS; t++) {
  const r = simulate(all, atr, regimes);
  runs.push(r);
  console.log(`  รอบ ${t + 1}/${TRIALS}: btc=${r.btc.toFixed(8)} (${r.coinsVsHold.toFixed(1)}%) | trend buys ${r.trendBuys} | bear sells ${r.bearSells} | recovery buys ${r.recoveryBuys}`);
}

const btc = stats(runs.map((r) => r.btc));
const vsHold = stats(runs.map((r) => r.coinsVsHold));
console.log(`\n### สรุป (n=${TRIALS})`);
console.log(`  BTC ตอนจบ: เฉลี่ย ${btc.mean.toFixed(8)} | sd ${btc.sd.toFixed(8)}`);
console.log(`  เทียบถือยาว: เฉลี่ย ${vsHold.mean.toFixed(2)}% | sd ${vsHold.sd.toFixed(2)}%`);
