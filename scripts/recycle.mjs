// ทดสอบวิธีทำให้ "เงินสดหมุนต่อ" แทนที่จะจมรอซื้อคืนเฉยๆ
//
// ปัญหาปัจจุบัน: เหรียญอยู่ในรูปเงินสด 38.5% ของเวลา เพราะ
//   1) อนุญาตให้มีคำสั่งซื้อคืนค้างได้แค่ 1 รายการ สปайค์ถัดไปถูกข้ามทั้งหมด
//   2) ถ้าราคาไม่ย่อถึงเป้า เงินจมไม่มีกำหนด (เคยวัดได้ 165 วัน)
//
// 3 แนวทางที่ทดสอบ:
//   A ปัจจุบัน           - 1 คำสั่ง, เป้าคงที่, รอไม่จำกัด
//   B หลายรอบพร้อมกัน    - เปิดได้ถึง K รอบ เงินก้อนใหม่ได้หมุนด้วย
//   C ผ่อนเป้าตามเวลา    - รอนานแล้วค่อยๆ ลดส่วนลดที่ต้องการ จนได้ซื้อคืนแน่ๆ (ไม่ยกเลิก ไม่ถือเงินสดค้าง)
//   D B + C รวมกัน
import { readFileSync } from "fs";

const FEE = 0.001, WARMUP = 60, ATR_MULT = 1.5, RETRACE = 0.2, MIN_BODY = 2.5, SIZE = 0.5;

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

// relaxHours: ทุกๆ N ชม.ที่ยังไม่ได้ซื้อคืน จะขยับเป้าเข้าใกล้ราคาที่ขายไปทีละขั้น
// จนถึงขั้นต่ำที่ยังได้เหรียญเพิ่ม (จุดคุ้มค่าธรรมเนียม) — ไม่มีการยกเลิกทิ้ง เงินได้กลับเป็นเหรียญเสมอ
function run(candles, atr, { maxOpen = 1, relaxHours = Infinity }) {
  let cash = 0;
  let btc = (300 / (1 + FEE)) / candles[WARMUP].c;
  const hold = 300 / candles[WARMUP].c;
  const pend = [];
  let cycles = 0, gained = 0, bars = 0, cashBars = 0, lastFlat = btc, maxWait = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i];
    if (!a) continue;
    bars++;
    cashBars += cash / (cash + btc * c.c);

    for (let k = pend.length - 1; k >= 0; k--) {
      const p = pend[k];
      const waited = i - p.at;
      // ผ่อนเป้า: ยิ่งรอนาน ยิ่งยอมรับส่วนลดน้อยลง แต่ไม่ต่ำกว่าจุดคุ้มค่าธรรมเนียม
      let target = p.target;
      if (relaxHours !== Infinity && waited > 0) {
        const steps = Math.floor(waited / relaxHours);
        const floor = p.sellPrice * (1 - FEE) / (1 + FEE);   // ซื้อคืนแพงกว่านี้ = เหรียญลด
        target = Math.min(floor, p.target + (floor - p.target) * Math.min(1, steps * 0.25));
      }
      if (c.l <= target) {
        const spend = Math.min(p.cash, cash);
        if (spend > 5) {
          const got = (spend / (1 + FEE)) / target;
          btc += got; cash -= spend; gained += got - p.qty; cycles++;
          if (waited > maxWait) maxWait = waited;
        }
        pend.splice(k, 1);
        if (!pend.length) lastFlat = btc;
      }
    }

    const body = c.c - c.o, bp = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > ATR_MULT * a && bp >= MIN_BODY)) continue;
    if (body <= 0 || pend.length >= maxOpen) continue;

    const q = btc * SIZE;
    if (q * c.c <= 5) continue;
    const pr = q * c.c * (1 - FEE);
    cash += pr; btc -= q;
    pend.push({ target: c.c - RETRACE * body, sellPrice: c.c, cash: pr, at: i, qty: q });
  }
  return {
    cycles, gainPct: gained / hold * 100,
    flatPct: (lastFlat / hold - 1) * 100,
    cashPct: cashBars / bars * 100,
    openEnd: pend.length, maxWaitDays: (maxWait / 24).toFixed(0),
  };
}

const all = JSON.parse(readFileSync("scripts/.cache/btc-1h-5y.json", "utf8"));
const atr = atrSeries(all, 14);
console.log(`ข้อมูลจริง 1h ${all.length} แท่ง = ${((all[all.length-1].t-all[0].t)/86400e3/365).toFixed(1)} ปี | ขาย ${SIZE*100}% ต่อรอบ\n`);

const VARIANTS = [
  { n: "A ปัจจุบัน (1 รอบ, รอไม่จำกัด)", o: { maxOpen: 1 } },
  { n: "B หลายรอบพร้อมกัน (สูงสุด 3)", o: { maxOpen: 3 } },
  { n: "B หลายรอบพร้อมกัน (สูงสุด 5)", o: { maxOpen: 5 } },
  { n: "C ผ่อนเป้าทุก 48 ชม.", o: { maxOpen: 1, relaxHours: 48 } },
  { n: "C ผ่อนเป้าทุก 168 ชม.", o: { maxOpen: 1, relaxHours: 168 } },
  { n: "D 3 รอบ + ผ่อนทุก 168 ชม.", o: { maxOpen: 3, relaxHours: 168 } },
  { n: "D 5 รอบ + ผ่อนทุก 168 ชม.", o: { maxOpen: 5, relaxHours: 168 } },
];

console.log("วิธี".padEnd(34) + "รอบ".padStart(5) + "เหรียญเพิ่ม".padStart(13) + "เงินสดจมเฉลี่ย".padStart(16) + "รอนานสุด".padStart(11) + "ค้างตอนจบ".padStart(11));
for (const v of VARIANTS) {
  const r = run(all, atr, v.o);
  console.log(
    v.n.padEnd(34) + String(r.cycles).padStart(5) +
    `${r.gainPct >= 0 ? "+" : ""}${r.gainPct.toFixed(2)}%`.padStart(13) +
    `${r.cashPct.toFixed(1)}%`.padStart(16) +
    `${r.maxWaitDays} วัน`.padStart(11) +
    String(r.openEnd).padStart(11)
  );
}
