// Service Worker สำหรับรับ Web Push แม้ปิดแท็บ/ปิดเบราว์เซอร์อยู่
// ต้องอยู่ที่ root ของเว็บ (ไม่ใช่ /src) เพื่อให้ scope ครอบคลุมทั้งไซต์ตามที่ Push API กำหนด
importScripts("https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js");

// ใช้ compat SDK เพราะ service worker เป็น context แยก import module ปกติไม่ได้ (ต้องใช้ importScripts)
firebase.initializeApp({
  apiKey: "AIzaSyDfoiU3RoVA5gi1JT2l4-jFF_fuU4RocPI",
  authDomain: "btc-paper-desk.firebaseapp.com",
  projectId: "btc-paper-desk",
  storageBucket: "btc-paper-desk.firebasestorage.app",
  messagingSenderId: "895629200666",
  appId: "1:895629200666:web:0feb82d76e2f1de7dbb0a3",
});

const messaging = firebase.messaging();

// ข้อความที่มาถึงตอนไม่มีแท็บเปิดอยู่ (หรือแท็บอยู่ background) จะเข้ามาที่นี่
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "CoinPlay";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "/icon-512.png",
    badge: "/favicon-32.png",
    data: { url: (payload.data && payload.data.url) || "/" },
    tag: (payload.data && payload.data.tag) || undefined,
  });
});

// กดที่ตัวแจ้งเตือนแล้วพาไปหน้าเทรด (โฟกัสแท็บเดิมถ้ามีอยู่แล้ว แทนที่จะเปิดใหม่ซ้อน)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
