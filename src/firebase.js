import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { isSupported } from "firebase/messaging";
import { firebaseConfig, ADMIN_EMAIL, VAPID_PUBLIC_KEY } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export { ADMIN_EMAIL, VAPID_PUBLIC_KEY };

// Push notification ใช้ไม่ได้ในบางสภาพแวดล้อม (Safari รุ่นเก่า, iOS ที่ยังไม่ได้ add-to-homescreen,
// หรือหน้าที่เปิดผ่าน http ธรรมดา) — เช็คก่อนค่อย getMessaging() กันแอปพังตอนโหลดหน้าในเบราว์เซอร์ที่ไม่รองรับ
export const messagingSupported = isSupported().catch(() => false);
