// ตัววนรันภายในหนึ่ง GitHub Actions job — เรียก check-orders ซ้ำๆ ทุก N วินาทีจนครบเวลาที่กำหนด
//
// ทำไมต้องมีไฟล์นี้: GitHub หน่วง scheduled workflow ที่ตั้งถี่มาก (ตั้ง 5 นาที ได้จริง ~36 นาที)
// การให้ job เดียววนเช็คเองข้างในจึงได้ความถี่จริงตามที่ต้องการ โดยไม่ต้องพึ่งความแม่นของ scheduler
//
// รันเป็น subprocess แยกทุกรอบ เพื่อให้แต่ละรอบเริ่มจาก state สะอาด
// และถ้ารอบไหนพังก็ไม่ทำให้ทั้ง loop ตาย (เช่น API ปลายทางล่มชั่วคราว)
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOP_MINUTES = parseFloat(process.env.LOOP_MINUTES || "58");
const INTERVAL_MS = parseFloat(process.env.LOOP_INTERVAL_SECONDS || "120") * 1000;
const deadline = Date.now() + LOOP_MINUTES * 60 * 1000;

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, "check-orders.mjs")], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => {
      console.error("failed to spawn check-orders:", err.message);
      resolve(1);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let iteration = 0, failures = 0;
console.log(`loop: จะวนเช็คทุก ${INTERVAL_MS / 1000} วินาที เป็นเวลา ${LOOP_MINUTES} นาที`);

while (Date.now() < deadline) {
  iteration++;
  const startedAt = Date.now();
  console.log(`\n===== รอบที่ ${iteration} — ${new Date().toISOString()} =====`);
  const code = await runOnce();
  if (code !== 0) {
    failures++;
    console.error(`รอบที่ ${iteration} จบด้วย exit code ${code} (สะสมพลาด ${failures} ครั้ง) — วนต่อ`);
    // ถ้าพังติดกันหลายรอบ แปลว่ามีปัญหาจริง (คีย์หมดอายุ/สิทธิ์หาย) หยุดเพื่อให้เห็นว่า workflow fail
    if (failures >= 5) {
      console.error("พังติดกัน 5 ครั้ง หยุด loop เพื่อให้ workflow ขึ้นสถานะ fail จะได้รู้ว่ามีปัญหา");
      process.exit(1);
    }
  } else {
    failures = 0;
  }

  const elapsed = Date.now() - startedAt;
  const wait = Math.max(0, INTERVAL_MS - elapsed);
  if (Date.now() + wait >= deadline) break; // ไม่ต้องรอถ้ารอเสร็จแล้วเลยเวลาพอดี
  await sleep(wait);
}

console.log(`\nloop จบ: รันไปทั้งหมด ${iteration} รอบ`);
