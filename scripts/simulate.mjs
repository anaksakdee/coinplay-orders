// เครื่องจำลองพอร์ต (portfolio simulator) — เอาแท่งเทียนจริงย้อนหลังมาเดินซ้ำผ่านตรรกะซื้อ/ขายจริง
// เพื่อวัดว่า "การบริหารเงิน" แบบไหนทำให้ได้จำนวน BTC มากกว่ากัน โดยไม่ต้องรอผลจริงเป็นวันๆ
//
// ใช้ scoreMarket ตัวเดียวกับระบบจริง (shared/strategy.mjs) ผลลัพธ์จึงเทียบเคียงของจริงได้
// รันเอง: node scripts/simulate.mjs
import { scoreMarket, positionFraction, THRESHOLDS, computeATR } from "../shared/strategy.mjs";
import { computeReturns } from "../shared/signals.mjs";
import { evaluateIndicators } from "../shared/backtest.mjs";

const FEE = 0.001;              // Binance 0.10%
const PROFIT_TARGET = 0.02;
const BTC_ACCUM_TARGET = 0.01;
const WARMUP = 120;             // ต้องมีแท่งพอสำหรับอินดิเคเตอร์

export async function fetchCandles(interval = "5m", limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("binance klines http " + res.status);
  const data = await res.json();
  return data.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

function ceiling(sellPrice, gain) {
  return (sellPrice * (1 - FEE)) / ((1 + FEE) * (1 + gain));
}

// cfg คือชุดกติกาบริหารเงินที่จะเอามาเทียบกัน
export function simulate(candles, cfg) {
  const startCash = cfg.startCash;
  let cash = startCash;
  let lots = [];            // {qty, price, sleeve}
  let lastSell = null;      // {price, qty, usd}
  let lastCoreAt = -Infinity;
  let coreSpent = 0;
  let roundTrips = 0, btcAccum = 0, buys = 0, sells = 0, blockedByRules = 0;
  let minCashPct = 1;

  const learned = evaluateIndicators(candles.slice(0, WARMUP), 20, 60);

  for (let i = WARMUP; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const price = window[window.length - 1].c;
    const returns = computeReturns(window);
    const analysis = scoreMarket(price, window, returns, learned);
    const score = analysis.composite;
    const atrPct = analysis.atrPct;
    // NaN เล็ดลอดผ่านการเทียบค่าได้ (NaN < 8 เป็น false) ต้องกันตรงนี้ ไม่งั้นบัญชีพังเป็น NaN ทั้งสาย
    if (!Number.isFinite(score) || !Number.isFinite(price)) continue;
    const btc = lots.reduce((a, l) => a + l.qty, 0);
    const equity = cash + btc * price;
    minCashPct = Math.min(minCashPct, cash / equity);

    // ---------- ขาย: ไม้ swing ที่ถึงเป้ากำไร ----------
    const target = cfg.dynamicTarget && atrPct
      ? Math.max(cfg.minProfit, Math.min(PROFIT_TARGET, atrPct / 100 * cfg.atrMultiple))
      : PROFIT_TARGET;
    // ทดสอบสมมติฐาน: "ขายแล้วซื้อคืนไม่ทัน" คือสาเหตุที่เหรียญหาย จึงมีสวิตช์ปิดการขาย
    // และสวิตช์ให้ขายเฉพาะตอนสัญญาณอ่อนจริง (ใกล้ยอด) ที่มีโอกาสย่อกลับให้ซื้อคืน
    const sellAllowed = !cfg.noSwingSell &&
      (cfg.sellRequiresScoreBelow == null || score <= cfg.sellRequiresScoreBelow);
    for (let j = 0; sellAllowed && j < lots.length; j++) {
      const lot = lots[j];
      if (lot.sleeve === "core") continue;
      const sellAt = lot.price * (1 + target) / (1 - FEE);
      if (price >= sellAt) {
        const amount = lot.qty * price;
        cash += amount * (1 - FEE);
        lastSell = { price, qty: lot.qty, usd: amount };
        lots.splice(j, 1);
        sells++;
        break;
      }
    }

    // ---------- ซื้อคืนปิดรอบ (ได้เหรียญเพิ่มจริง) ----------
    const accumTarget = cfg.btcAccumTarget != null ? cfg.btcAccumTarget : BTC_ACCUM_TARGET;
    if (lastSell && price <= ceiling(lastSell.price, accumTarget)) {
      const spend = (lastSell.usd * (1 - FEE)) / (1 + FEE);
      if (spend * (1 + FEE) <= cash && spend > cfg.minTicket) {
        const qty = spend / price;
        cash -= spend * (1 + FEE);
        lots.push({ qty, price, sleeve: "swing" });
        btcAccum += qty - lastSell.qty;
        roundTrips++; buys++;
        lastSell = null;
        continue;
      }
    }

    // ---------- ขาสะสมระยะยาว (core) ----------
    const coreDue = candles[i].t - lastCoreAt >= cfg.coreIntervalMs;
    const coreCapOk = coreSpent < startCash * cfg.coreMaxPct;
    if (coreDue && coreCapOk && score > THRESHOLDS.strongSell) {
      const amt = Math.max(cfg.minTicket, startCash * cfg.coreFractionOfStart);
      if (amt * (1 + FEE) <= cash) {
        const qty = amt / price;
        cash -= amt * (1 + FEE);
        lots.push({ qty, price, sleeve: "core" });
        coreSpent += amt; lastCoreAt = candles[i].t; buys++;
        continue;
      }
    }

    // ---------- ซื้อไม้ swing ตามสัญญาณ ----------
    if (score < cfg.buyThreshold) continue;

    const openSwing = lots.filter((l) => l.sleeve !== "core");
    if (openSwing.length >= cfg.maxOpenSwing) { blockedByRules++; continue; }

    // ห้ามเปิดไม้ใหม่ใกล้ราคาไม้เดิม (กันซื้อกองที่ราคาเดียวกันจนกลายเป็นก้อนเดียว)
    if (cfg.minSeparationPct > 0 &&
        openSwing.some((l) => Math.abs(price / l.price - 1) * 100 < cfg.minSeparationPct)) {
      blockedByRules++; continue;
    }

    // ขนาดไม้: อิง equity ทั้งพอร์ต (ไม่ใช่เงินสดที่เหลือ) จะได้ไม่บานปลายตอนเงินสดเยอะ
    const rawFrac = positionFraction(score, atrPct);
    const base = cfg.sizeOffEquity ? equity : cash;
    let amt = base * Math.min(rawFrac, cfg.maxPositionPct);

    // กันเงินสดสำรอง: ห้ามซื้อจนเงินสดต่ำกว่าพื้นที่กำหนด
    const floor = equity * cfg.cashFloorPct;
    const spendable = Math.max(0, cash - floor);
    amt = Math.min(amt, spendable / (1 + FEE));

    if (!Number.isFinite(amt) || amt < cfg.minTicket) { blockedByRules++; continue; }

    const qty = amt / price;
    cash -= amt * (1 + FEE);
    lots.push({ qty, price, sleeve: "swing" });
    buys++;
  }

  const lastPrice = candles[candles.length - 1].c;
  const btc = lots.reduce((a, l) => a + l.qty, 0);
  return {
    cash, btc, equity: cash + btc * lastPrice,
    lots: lots.length,
    openSwing: lots.filter((l) => l.sleeve !== "core").length,
    buys, sells, roundTrips, btcAccum, blockedByRules,
    minCashPct,
    // ตัวชี้วัดที่ตรงกับเป้าหมายจริง: ถ้าเอาเงินทั้งหมดไปซื้อ BTC ตั้งแต่แรกจะได้กี่เหรียญ เทียบกับที่ทำได้จริง
    btcIfHeld: startCash / candles[WARMUP].c,
    btcEquivalent: (cash + btc * lastPrice) / lastPrice,
  };
}

export const CFG_CURRENT = {
  startCash: 300, minTicket: 10,
  buyThreshold: THRESHOLDS.weakBuy,   // 8
  maxOpenSwing: Infinity,
  minSeparationPct: 0,
  sizeOffEquity: false,               // อิงเงินสดที่เหลือ
  maxPositionPct: 0.6,
  cashFloorPct: 0,                    // ไม่มีเงินสดสำรอง
  coreIntervalMs: 12 * 3600e3, coreFractionOfStart: 0.10, coreMaxPct: Infinity,
  dynamicTarget: false, minProfit: 0.008, atrMultiple: 6,
};

export const CFG_MANAGED = {
  startCash: 300, minTicket: 10,
  buyThreshold: 18,                   // เลือกเฉพาะสัญญาณที่มั่นใจจริง
  maxOpenSwing: 4,                    // จำกัดไม้ที่เปิดพร้อมกัน
  minSeparationPct: 0.6,              // ไม้ใหม่ต้องห่างจากไม้เดิม >= 0.6%
  sizeOffEquity: true,
  maxPositionPct: 0.18,               // ไม้ละไม่เกิน 18% ของพอร์ต
  cashFloorPct: 0.25,                 // กันเงินสดสำรองไว้ 25% เสมอ
  coreIntervalMs: 12 * 3600e3, coreFractionOfStart: 0.05, coreMaxPct: 0.30,
  dynamicTarget: true, minProfit: 0.008, atrMultiple: 6,
};

function report(name, r, startCash) {
  const pct = (a, b) => ((a / b - 1) * 100).toFixed(2) + "%";
  console.log(`\n===== ${name} =====`);
  console.log(`  ซื้อ ${r.buys} / ขาย ${r.sells} ครั้ง | รอบครบวง ${r.roundTrips} | ถูกกติกาเบรก ${r.blockedByRules} ครั้ง`);
  console.log(`  เงินสดเหลือ ${r.cash.toFixed(2)} | เงินสดต่ำสุดที่เคยลงไป ${(r.minCashPct * 100).toFixed(1)}% ของพอร์ต`);
  console.log(`  ไม้ที่ยังเปิดค้าง ${r.lots} (swing ${r.openSwing})`);
  console.log(`  BTC ที่ถือจริง ${r.btc.toFixed(8)}`);
  console.log(`  พอร์ตคิดเป็น BTC รวม ${r.btcEquivalent.toFixed(8)}  (ถ้าซื้อทีเดียวตั้งแต่ต้นแล้วถือเฉยๆ = ${r.btcIfHeld.toFixed(8)}, ต่างกัน ${pct(r.btcEquivalent, r.btcIfHeld)})`);
  console.log(`  กำไรที่เป็นเหรียญจากการหมุนรอบ ${r.btcAccum >= 0 ? "+" : ""}${r.btcAccum.toFixed(8)} BTC`);
}

if (process.argv[1] && process.argv[1].endsWith("simulate.mjs")) {
  const interval = process.argv[2] || "5m";
  const candles = await fetchCandles(interval, 1000);
  const days = ((candles[candles.length - 1].t - candles[0].t) / 86400e3).toFixed(1);
  console.log(`ข้อมูลจริง BTCUSDT ${interval} จำนวน ${candles.length} แท่ง (~${days} วัน)`);
  console.log(`ราคาเริ่ม ${candles[WARMUP].c.toFixed(2)} -> ราคาจบ ${candles[candles.length - 1].c.toFixed(2)}`);
  report("กติกาปัจจุบัน (ที่ทำให้เงินร่อยหรอ)", simulate(candles, CFG_CURRENT), 300);
  report("กติกาใหม่ (บริหารเงิน)", simulate(candles, CFG_MANAGED), 300);
}
