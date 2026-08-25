// Firebase project: btc-paper-desk (สร้างและ deploy โดย Firebase CLI ภายใต้บัญชี anaksakdee@gmail.com)
export const firebaseConfig = {
  apiKey: "AIzaSyDfoiU3RoVA5gi1JT2l4-jFF_fuU4RocPI",
  authDomain: "btc-paper-desk.firebaseapp.com",
  projectId: "btc-paper-desk",
  storageBucket: "btc-paper-desk.firebasestorage.app",
  messagingSenderId: "895629200666",
  appId: "1:895629200666:web:0feb82d76e2f1de7dbb0a3"
};

// อีเมลเดียวที่มีสิทธิ์เห็นหน้า Admin / ข้อมูล logs ทั้งหมด
export const ADMIN_EMAIL = "anaksakdee@gmail.com";

// VAPID public key สำหรับ Web Push — เป็น public key จริงๆ (ไม่ใช่ความลับ ฝังในโค้ด client ได้ปกติ)
// generate เองด้วย Node crypto (ECDSA P-256 มาตรฐาน RFC 8292) ไม่ต้องพึ่ง Firebase Console
// private key ไม่ต้องเก็บที่ไหนเลย เพราะฝั่งเซิร์ฟเวอร์ส่ง push ผ่าน Firebase Admin SDK
// ซึ่งใช้ service account credential ยืนยันตัวตน ไม่ได้ใช้ VAPID private key เซ็นเอง
export const VAPID_PUBLIC_KEY = "BKccpdG1gnqU0GyaQQbKiL06CMjLNHp4I39WJx8hnZY5mXWcHO3ItwR2_w7JhyBq2hj723Cn5xhcxD1U9JUYG1I";
