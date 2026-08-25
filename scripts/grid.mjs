// หาคำตอบว่า "บนแท่ง 15 นาที ต้องตั้งกี่ % ถึงจะได้กำไร"
// ไล่ทดสอบทุกคู่ของ (ขนาดไม้ขั้นต่ำ x ระยะย่อ) กับข้อมูลจริง 3 ปี แล้วดูว่าคู่ไหนเป็นบวกทุกปี
//
// รัน: node scripts/grid.mjs 15m
import { readFileSync } from "fs";

const FEE = 0.001; // Binance 0.10%
const WARMUP = 60;
const TRADE_PCT = 0.2;
const ATR_MULT = 1.5;

function atrSeries(candles, period = 14) {
  const tr = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let v = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = v;
  for (let i = period + 1; i < candles.length; i++) { v = (v * (period - 1) + tr[i]) / period; out[i] = v; }
  return out;
}

function run(candles, atr, minBodyPct, retrace, tradePct = TRADE_PCT) {
  let cash = 0;
  let btc = (300 / (1 + FEE)) / candles[WARMUP].c;
  let pendBuy = null, pendSell = null;
  let sells = 0, rebuys = 0, fills = 0, attempts = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i];
    if (!a) continue;
    if (pendBuy && c.l <= pendBuy.target) {
      const spend = Math.min(pendBuy.cash, cash);
      if (spend > 5) { btc += (spend / (1 + FEE)) / pendBuy.target; cash -= spend; rebuys++; fills++; }
      pendBuy = null;
    }
    if (pendSell && c.h >= pendSell.target) {
      const q = Math.min(pendSell.qty, btc);
      if (q * pendSell.target > 5) { cash += q * pendSell.target * (1 - FEE); btc -= q; fills++; }
      pendSell = null;
    }
    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > ATR_MULT * a && bodyPct >= minBodyPct)) continue;

    if (body > 0) {
      if (pendBuy) continue;
      const q = btc * tradePct;
      if (q * c.c > 5) {
        const proceeds = q * c.c * (1 - FEE);
        cash += proceeds; btc -= q; sells++; attempts++;
        pendBuy = { target: c.c - retrace * body, cash: proceeds };
      }
    } else {
      if (pendSell) continue;
      const spend = cash * tradePct;
      if (spend > 5) {
        const q = (spend / (1 + FEE)) / c.c;
        btc += q; cash -= spend; attempts++;
        pendSell = { target: c.c + retrace * Math.abs(body), qty: q };
      }
    }
  }
  const last = candles[candles.length - 1].c;
  return {
    vsHold: (((cash + btc * last) / last) / (300 / candles[WARMUP].c) - 1) * 100,
    attempts, fills, fillRate: attempts ? fills / attempts * 100 : 0,
  };
}

const interval = process.argv[2] || "15m";
const all = JSON.parse(readFileSync(`scripts/.cache/btc-${interval}-3y.json`, "utf8"));
console.log(`ข้อมูลจริง BTCUSDT ${interval} ${all.length} แท่ง = ${((all[all.length-1].t-all[0].t)/86400e3/365).toFixed(2)} ปี\n`);

const YEAR = 365 * 86400e3;
const windows = [];
for (let s = all[0].t; s < all[all.length - 1].t; s += YEAR) {
  const w = all.filter((c) => c.t >= s && c.t < s + YEAR);
  if (w.length > 200) windows.push({ c: w, a: atrSeries(w, 14) });
}

const BODIES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const RETRACES = [0.2, 0.3, 0.4, 0.5];

console.log("จุดคุ้มทุนตามทฤษฎี: ระยะย่อ x ขนาดไม้ ต้อง > ค่าธรรมเนียมไป-กลับ (0.2%)");
for (const r of RETRACES) console.log(`  ย่อ ${(r*100).toFixed(0)}% -> ไม้ต้องยาวเกิน ${(0.2 / r).toFixed(2)}% ถึงจะเริ่มไม่ขาดทุน`);

console.log("\n===== ผลจริง 3 ปี (ตัวเลข = เฉลี่ยเทียบถือเฉยๆ, วงเล็บ = ชนะกี่ปีจาก 3) =====");
console.log("ไม้ยาว\\ย่อ  " + RETRACES.map((r) => `${(r*100).toFixed(0)}%`.padStart(16)).join(""));

const results = [];
for (const b of BODIES) {
  let row = `>=${b.toFixed(2)}%`.padEnd(12);
  for (const r of RETRACES) {
    const per = windows.map((w) => run(w.c, w.a, b, r));
    const avg = per.reduce((a, x) => a + x.vsHold, 0) / per.length;
    const wins = per.filter((x) => x.vsHold > 0).length;
    const fillRate = per.reduce((a, x) => a + x.fillRate, 0) / per.length;
    const trades = per.reduce((a, x) => a + x.attempts, 0);
    results.push({ b, r, avg, wins, fillRate, trades });
    const cell = `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%(${wins}/3)`;
    row += cell.padStart(16);
  }
  console.log(row);
}

console.log("\n===== คู่ที่ 'กำไรทุกปี' (ชนะ 3/3) =====");
const winners = results.filter((x) => x.wins === 3).sort((a, b) => b.avg - a.avg);
if (!winners.length) console.log("  ไม่มีคู่ไหนกำไรครบทั้ง 3 ปีเลยบนไทม์เฟรมนี้");
for (const w of winners) {
  console.log(`  ไม้ยาว >=${w.b}% + ย่อ ${(w.r*100).toFixed(0)}%  ->  เฉลี่ย +${w.avg.toFixed(2)}% | เข้าเทรด ${w.trades} ครั้ง/3ปี | ปิดรอบสำเร็จ ${w.fillRate.toFixed(0)}%`);
}

console.log("\n===== 5 อันดับแรกตามค่าเฉลี่ย =====");
results.sort((a, b) => b.avg - a.avg).slice(0, 5).forEach((w, i) => {
  console.log(`  ${i+1}. ไม้ >=${w.b}% ย่อ ${(w.r*100).toFixed(0)}% -> ${w.avg >= 0 ? "+" : ""}${w.avg.toFixed(2)}% (ชนะ ${w.wins}/3) | ${w.trades} ครั้ง | ปิดรอบ ${w.fillRate.toFixed(0)}%`);
});

// ---------- ตารางที่ 2: เพิ่ม "ปริมาณการซื้อขาย" ----------
// ตรึงระยะย่อไว้ที่ 20% (คอลัมน์เดียวที่กำไรทุกปี) แล้วไล่ทั้ง 2 ทางที่จะเพิ่มปริมาณ:
//   แนวนอน = ขนาดไม้ต่ำลง -> เข้าเทรดถี่ขึ้น
//   แนวตั้ง = เทรดครั้งละกี่ % ของพอร์ต -> ไม้ใหญ่ขึ้นต่อครั้ง
const SIZES = [0.2, 0.3, 0.4, 0.5, 0.6];
const BODIES2 = [1.5, 2.0, 2.5, 3.0];
console.log("\n\n===== เพิ่มปริมาณการซื้อขาย (ตรึงย่อ 20%) =====");
console.log("เทรดครั้งละ\ไม้ยาว" + BODIES2.map((b) => `>=${b}%`.padStart(17)).join(""));
const grid2 = [];
for (const s of SIZES) {
  let row = `${(s * 100).toFixed(0)}% ของพอร์ต`.padEnd(18);
  for (const b of BODIES2) {
    const per = windows.map((w) => run(w.c, w.a, b, 0.2, s));
    const avg = per.reduce((a, x) => a + x.vsHold, 0) / per.length;
    const wins = per.filter((x) => x.vsHold > 0).length;
    const trades = per.reduce((a, x) => a + x.attempts, 0);
    const fillRate = per.reduce((a, x) => a + x.fillRate, 0) / per.length;
    grid2.push({ s, b, avg, wins, trades, fillRate });
    row += `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%(${wins}/3)`.padStart(17);
  }
  console.log(row);
}
console.log("\n----- เรียงตามผลตอบแทน เฉพาะที่กำไรครบ 3/3 ปี -----");
const w2 = grid2.filter((x) => x.wins === 3).sort((a, b) => b.avg - a.avg);
if (!w2.length) console.log("  ไม่มี");
w2.forEach((x, i) => console.log(`  ${i + 1}. เทรดครั้งละ ${(x.s * 100).toFixed(0)}% + ไม้ >=${x.b}% -> +${x.avg.toFixed(2)}% | ${x.trades} ครั้ง/3ปี | ปิดรอบ ${x.fillRate.toFixed(0)}%`));

// ---------- ตารางที่ 3: ดันขนาดไม้ต่อครั้งให้สุด เพื่อดูว่ามีจุดที่พังไหม ----------
console.log("\n\n===== ดันปริมาณต่อครั้งให้สุด (ไม้ >=2.5%, ย่อ 20%) — ดูผลรายปีด้วย =====");
console.log("เทรดครั้งละ".padEnd(14) + "เฉลี่ย".padStart(9) + "  |" + windows.map((_, i) => `ปีที่${i+1}`.padStart(9)).join("") + "   ปิดรอบ");
for (const s of [0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const per = windows.map((w) => run(w.c, w.a, 2.5, 0.2, s));
  const avg = per.reduce((a, x) => a + x.vsHold, 0) / per.length;
  const fr = per.reduce((a, x) => a + x.fillRate, 0) / per.length;
  console.log(
    `${(s * 100).toFixed(0)}% ของพอร์ต`.padEnd(14) +
    `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`.padStart(9) + "  |" +
    per.map((x) => `${x.vsHold >= 0 ? "+" : ""}${x.vsHold.toFixed(2)}%`.padStart(9)).join("") +
    `   ${fr.toFixed(0)}%`
  );
}
