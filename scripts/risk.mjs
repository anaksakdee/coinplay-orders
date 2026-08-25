// เลือก "ขนาดเทรดต่อครั้ง" ที่ดีที่สุดโดยดูความเสี่ยงด้วย ไม่ใช่ดูแค่ผลตอบแทนสูงสุด
//
// 3 อย่างที่ตรวจเพิ่มจากเดิม:
//   1) ใช้ข้อมูลยาวขึ้น (5 ปี) -> มีสปайค์มากขึ้น สถิติน่าเชื่อถือขึ้น
//   2) วัดว่ามี "คำสั่งซื้อคืนที่ไม่เคยได้ซื้อ" จริงไหม และค้างนานแค่ไหน
//   3) ทดสอบความทน (stress test): บังคับให้ซื้อคืนพลาดตามอัตราที่กำหนด แล้วดูว่าแต่ละขนาดเจ็บแค่ไหน
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const FEE = 0.001, WARMUP = 60, ATR_MULT = 1.5, RETRACE = 0.2, MIN_BODY = 2.5;
const CACHE = "scripts/.cache";

async function fetchAll(interval, years) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/btc-${interval}-${years}y.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const end = Date.now(), start = end - years * 365 * 86400e3;
  const out = []; let cur = start;
  process.stdout.write("ดึงข้อมูล");
  while (cur < end) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cur}&limit=1000`);
    if (!r.ok) throw new Error("http " + r.status);
    const d = await r.json();
    if (!d.length) break;
    for (const k of d) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    cur = d[d.length - 1][0] + 1;
    process.stdout.write(".");
    if (d.length < 1000) break;
  }
  console.log(" " + out.length + " แท่ง");
  writeFileSync(f, JSON.stringify(out));
  return out;
}

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

// missRate = สัดส่วนคำสั่งซื้อคืนที่ "บังคับให้พลาด" เพื่อทดสอบความทน (0 = ตามจริง)
// ใช้ลำดับแบบกำหนดตายตัว (ทุกๆ n ครั้งพลาด 1) จะได้ผลลัพธ์ซ้ำได้ ไม่สุ่มมั่ว
function run(candles, atr, tradePct, timeoutBars = Infinity) {
  let cash = 0;
  let btc = (300 / (1 + FEE)) / candles[WARMUP].c;
  let pend = null, spikes = 0, filled = 0, missed = 0, maxOpenBars = 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i], a = atr[i];
    if (!a) continue;
    if (pend) {
      const openBars = i - pend.at;
      if (openBars > maxOpenBars) maxOpenBars = openBars;
      if (c.l <= pend.target) {
        const spend = Math.min(pend.cash, cash);
        if (spend > 5) { btc += (spend / (1 + FEE)) / pend.target; cash -= spend; filled++; }
        pend = null;
      } else if (openBars >= timeoutBars) { missed++; pend = null; }
    }
    const body = c.c - c.o;
    const bodyPct = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > ATR_MULT * a && bodyPct >= MIN_BODY)) continue;
    if (body <= 0 || pend) continue;   // ทดสอบเฉพาะฝั่งไม้เขียว (ขายรับรอบ) ซึ่งเป็นตัวเสี่ยงหลัก

    spikes++;
    const q = btc * tradePct;
    if (q * c.c <= 5) continue;
    const proceeds = q * c.c * (1 - FEE);
    cash += proceeds; btc -= q;
    pend = { target: c.c - RETRACE * body, cash: proceeds, at: i };
  }
  const last = candles[candles.length - 1].c;
  return {
    vsHold: (((cash + btc * last) / last) / (300 / candles[WARMUP].c) - 1) * 100,
    spikes, filled, missed, stillOpen: pend ? 1 : 0, maxOpenBars,
  };
}

const interval = "1h";
const all = await fetchAll(interval, 5);
const years = (all[all.length - 1].t - all[0].t) / 86400e3 / 365;
console.log(`\nBTCUSDT ${interval} ${all.length} แท่ง = ${years.toFixed(2)} ปี (${new Date(all[0].t).toISOString().slice(0,10)} ถึง ${new Date(all[all.length-1].t).toISOString().slice(0,10)})`);

const YEAR = 365 * 86400e3;
const wins = [];
for (let s = all[0].t; s < all[all.length - 1].t; s += YEAR) {
  const w = all.filter((c) => c.t >= s && c.t < s + YEAR);
  if (w.length > 500) wins.push({ c: w, a: atrSeries(w, 14), chg: (w[w.length-1].c / w[60].c - 1) * 100 });
}
console.log(`แบ่งเป็น ${wins.length} ปี: ` + wins.map((w, i) => `ปี${i+1} ${w.chg >= 0 ? "+" : ""}${w.chg.toFixed(0)}%`).join(", "));

const SIZES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];

console.log("\n===== 1) ผลตามจริง 5 ปี (ไม้ >=2.5%, ย่อ 20%) =====");
console.log("ขนาด".padEnd(8) + "เฉลี่ย".padStart(9) + "  แย่สุด".padStart(10) + "  ชนะ".padStart(7) + "   สปайค์  ซื้อคืนได้  ค้างไม่ได้ซื้อ  ค้างนานสุด");
const base = [];
for (const s of SIZES) {
  const per = wins.map((w) => run(w.c, w.a, s));
  const avg = per.reduce((a, x) => a + x.vsHold, 0) / per.length;
  const worst = Math.min(...per.map((x) => x.vsHold));
  const w3 = per.filter((x) => x.vsHold > 0).length;
  const sp = per.reduce((a, x) => a + x.spikes, 0);
  const fl = per.reduce((a, x) => a + x.filled, 0);
  const op = per.reduce((a, x) => a + x.stillOpen, 0);
  const mo = Math.max(...per.map((x) => x.maxOpenBars));
  base.push({ s, avg, worst, w3, sp, fl, op });
  console.log(`${(s*100).toFixed(0)}%`.padEnd(8) + `${avg>=0?"+":""}${avg.toFixed(2)}%`.padStart(9) + `${worst>=0?"+":""}${worst.toFixed(2)}%`.padStart(10) + `${w3}/${per.length}`.padStart(7) + `${sp}`.padStart(9) + `${fl}`.padStart(11) + `${op}`.padStart(14) + `${mo} ชม.`.padStart(12));
}


console.log("\n===== 2) ถ้าใส่ timeout ยกเลิกคำสั่งซื้อคืนที่ค้างนานเกินไป =====");
console.log("(ตามจริงมีคำสั่งค้าง 1 รายการนาน 3976 ชม. = 165 วัน ที่เงินจมอยู่ เทรดต่อไม่ได้)");
const TOS = [
  { n: "ไม่มี timeout", v: Infinity },
  { n: "24 ชม.", v: 24 },
  { n: "72 ชม.", v: 72 },
  { n: "168 ชม.", v: 168 },
  { n: "720 ชม.", v: 720 },
];
console.log("ขนาด".padEnd(8) + TOS.map((t) => t.n.padStart(16)).join(""));
for (const sz of SIZES) {
  let row = `${(sz * 100).toFixed(0)}%`.padEnd(8);
  for (const t of TOS) {
    const per = wins.map((w) => run(w.c, w.a, sz, t.v));
    const avg = per.reduce((a, x) => a + x.vsHold, 0) / per.length;
    const wn = per.filter((x) => x.vsHold > 0).length;
    row += `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%(${wn}/5)`.padStart(16);
  }
  console.log(row);
}

console.log("\n===== ตรวจสอบ: แยกรายปี (ขนาด 50%) =====");
for (const t of [{n:"ไม่มี timeout",v:Infinity},{n:"72 ชม.",v:72},{n:"720 ชม.",v:720}]) {
  const per = wins.map((w) => run(w.c, w.a, 0.5, t.v));
  console.log(t.n.padEnd(16) + per.map((x,i)=>`ปี${i+1}(${wins[i].chg>=0?"+":""}${wins[i].chg.toFixed(0)}%): ${x.vsHold>=0?"+":""}${x.vsHold.toFixed(1)}%`.padStart(22)).join(""));
}

console.log("\n\n===== ตรวจว่าตัววัดตรงกับเป้าหมาย 'จำนวนเหรียญที่ถือจริง' ไหม =====");
console.log("A = นับเงินสดเป็น BTC ด้วย (ที่ใช้วัดมาตลอด) | B = นับเฉพาะเหรียญที่ถืออยู่จริง");
console.log("ขนาด".padEnd(8) + "A เทียบถือเฉยๆ".padStart(18) + "B เทียบถือเฉยๆ".padStart(18) + "  เงินสดค้างตอนจบ");
for (const sz of [0.2, 0.5, 1.0]) {
  const per = wins.map((w) => {
    const r = run(w.c, w.a, sz);
    return r;
  });
  // รันใหม่แบบเก็บสถานะจบ เพื่อดูจำนวนเหรียญจริง
  const detail = wins.map((w) => {
    let cash = 0, btc = (300 / (1 + FEE)) / w.c[WARMUP].c;
    let pend = null;
    const atr = w.a;
    for (let i = WARMUP; i < w.c.length; i++) {
      const c = w.c[i], a = atr[i];
      if (!a) continue;
      if (pend && c.l <= pend.target) {
        const spend = Math.min(pend.cash, cash);
        if (spend > 5) { btc += (spend / (1 + FEE)) / pend.target; cash -= spend; }
        pend = null;
      }
      const body = c.c - c.o, bp = Math.abs(body) / c.c * 100;
      if (!(Math.abs(body) > ATR_MULT * a && bp >= MIN_BODY)) continue;
      if (body <= 0 || pend) continue;
      const q = btc * sz;
      if (q * c.c <= 5) continue;
      const pr = q * c.c * (1 - FEE);
      cash += pr; btc -= q;
      pend = { target: c.c - RETRACE * body, cash: pr, at: i };
    }
    const last = w.c[w.c.length - 1].c;
    const hold = 300 / w.c[WARMUP].c;
    return {
      a: ((cash + btc * last) / last / hold - 1) * 100,
      b: (btc / hold - 1) * 100,
      cashPct: cash / (cash + btc * last) * 100,
    };
  });
  const avgA = detail.reduce((x, y) => x + y.a, 0) / detail.length;
  const avgB = detail.reduce((x, y) => x + y.b, 0) / detail.length;
  const avgCash = detail.reduce((x, y) => x + y.cashPct, 0) / detail.length;
  console.log(`${(sz*100).toFixed(0)}%`.padEnd(8) + `${avgA>=0?"+":""}${avgA.toFixed(2)}%`.padStart(18) + `${avgB>=0?"+":""}${avgB.toFixed(2)}%`.padStart(18) + `${avgCash.toFixed(1)}%`.padStart(18));
}

console.log("\n===== สาเหตุ: เงินจมเป็นเงินสด 'กี่ % ของเวลา' ระหว่างรอซื้อคืน =====");
for (const sz of [0.2, 0.5, 1.0]) {
  const d = wins.map((w) => {
    let cash = 0, btc = (300 / (1 + FEE)) / w.c[WARMUP].c;
    let pend = null, barsPending = 0, bars = 0, sumCashFrac = 0;
    for (let i = WARMUP; i < w.c.length; i++) {
      const c = w.c[i], a = w.a[i];
      if (!a) continue;
      bars++;
      if (pend) barsPending++;
      sumCashFrac += cash / (cash + btc * c.c);
      if (pend && c.l <= pend.target) {
        const sp = Math.min(pend.cash, cash);
        if (sp > 5) { btc += (sp / (1 + FEE)) / pend.target; cash -= sp; }
        pend = null;
      }
      const body = c.c - c.o, bp = Math.abs(body) / c.c * 100;
      if (!(Math.abs(body) > ATR_MULT * a && bp >= MIN_BODY)) continue;
      if (body <= 0 || pend) continue;
      const q = btc * sz;
      if (q * c.c <= 5) continue;
      const pr = q * c.c * (1 - FEE);
      cash += pr; btc -= q;
      pend = { target: c.c - RETRACE * body, cash: pr, at: i };
    }
    return { pendPct: barsPending / bars * 100, cashPct: sumCashFrac / bars * 100 };
  });
  const p = d.reduce((a, x) => a + x.pendPct, 0) / d.length;
  const cp = d.reduce((a, x) => a + x.cashPct, 0) / d.length;
  console.log(`  ขนาด ${(sz*100).toFixed(0)}%  ->  มีคำสั่งค้างอยู่ ${p.toFixed(1)}% ของเวลา | เงินอยู่ในรูปเงินสดเฉลี่ย ${cp.toFixed(1)}% ของพอร์ตตลอดเวลา`);
}

console.log("\n===== วัดให้ถูก: รันยาว 5 ปีต่อเนื่อง นับเหรียญตอนที่ 'ไม่มีคำสั่งค้าง' =====");
const atrAll = atrSeries(all, 14);
for (const sz of [0.2, 0.3, 0.5, 0.8, 1.0]) {
  let cash = 0, btc = (300 / (1 + FEE)) / all[WARMUP].c;
  const hold = 300 / all[WARMUP].c;
  let pend = null, cycles = 0, coinsFromCycles = 0;
  let lastFlatBtc = btc, lastFlatIdx = WARMUP;
  for (let i = WARMUP; i < all.length; i++) {
    const c = all[i], a = atrAll[i];
    if (!a) continue;
    if (pend && c.l <= pend.target) {
      const sp = Math.min(pend.cash, cash);
      if (sp > 5) {
        const got = (sp / (1 + FEE)) / pend.target;
        btc += got; cash -= sp;
        coinsFromCycles += got - pend.qtySold; cycles++;
      }
      pend = null;
      lastFlatBtc = btc; lastFlatIdx = i;      // จุดที่ไม่มีคำสั่งค้าง = วัดเหรียญได้ตรง
    }
    const body = c.c - c.o, bp = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > ATR_MULT * a && bp >= MIN_BODY)) continue;
    if (body <= 0 || pend) continue;
    const q = btc * sz;
    if (q * c.c <= 5) continue;
    const pr = q * c.c * (1 - FEE);
    cash += pr; btc -= q;
    pend = { target: c.c - RETRACE * body, cash: pr, at: i, qtySold: q };
  }
  const openAtEnd = pend ? "ใช่" : "ไม่";
  console.log(`  ขนาด ${String((sz*100).toFixed(0)).padStart(3)}%  ->  ปิดรอบได้ ${String(cycles).padStart(2)} รอบ | เหรียญที่ได้เพิ่มจากการหมุนรอบ ${coinsFromCycles>=0?"+":""}${(coinsFromCycles/hold*100).toFixed(2)}% | เหรียญ ณ จุดปิดรอบล่าสุด ${((lastFlatBtc/hold-1)*100)>=0?"+":""}${((lastFlatBtc/hold-1)*100).toFixed(2)}% เทียบถือเฉยๆ | ค้างตอนจบ: ${openAtEnd}`);
}

console.log("\n===== เทียบ 50% (ปัจจุบัน) กับ 75% (ตามที่สั่ง) บน 5 ปีต่อเนื่อง =====");
const atrA = atrSeries(all, 14);
for (const sz of [0.5, 0.75, 0.8]) {
  let cash = 0, btc = (300 / (1 + FEE)) / all[WARMUP].c;
  const hold = 300 / all[WARMUP].c;
  let pend = null, cycles = 0, gained = 0, barsPend = 0, bars = 0, lastFlat = btc;
  for (let i = WARMUP; i < all.length; i++) {
    const c = all[i], a = atrA[i];
    if (!a) continue;
    bars++; if (pend) barsPend++;
    if (pend && c.l <= pend.target) {
      const sp = Math.min(pend.cash, cash);
      if (sp > 5) { const g = (sp / (1 + FEE)) / pend.target; btc += g; cash -= sp; gained += g - pend.qtySold; cycles++; }
      pend = null; lastFlat = btc;
    }
    const body = c.c - c.o, bp = Math.abs(body) / c.c * 100;
    if (!(Math.abs(body) > ATR_MULT * a && bp >= MIN_BODY)) continue;
    if (body <= 0 || pend) continue;
    const q = btc * sz;
    if (q * c.c <= 5) continue;
    const pr = q * c.c * (1 - FEE);
    cash += pr; btc -= q;
    pend = { target: c.c - RETRACE * body, cash: pr, at: i, qtySold: q };
  }
  console.log(`  ขาย ${(sz*100).toFixed(0)}%  ->  ปิดรอบ ${cycles} รอบ | เหรียญเพิ่ม ${(gained/hold*100)>=0?"+":""}${(gained/hold*100).toFixed(2)}% | เหรียญ ณ จุดปิดรอบล่าสุด ${((lastFlat/hold-1)*100)>=0?"+":""}${((lastFlat/hold-1)*100).toFixed(2)}% | เหรียญอยู่ในรูปเงินสด ${(barsPend/bars*sz*100).toFixed(1)}% ของเวลา`);
}
