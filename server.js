const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ
const OFFLINE_TIMEOUT_MS = 6000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const STORE_FILE = path.join(__dirname, 'store.json');

function loadStore() {
  if (fs.existsSync(STORE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (e) {}
  }
  const initial = {
    vapidKeys: {
      publicKey: process.env.VAPID_PUBLIC_KEY || 'BDZNEVyujUTNQzb1yVYfDkCMeXtPunYY4i24QCMHFLBLP_PRw4X8iRdw2M8SkRPpjNvEF1xfPzl4HtigW1B8iEU',
      privateKey: process.env.VAPID_PRIVATE_KEY || 'zrkNTEY9M0EI1SgReOiogO7DiTTCE3vQ66Vuvxkx14E'
    },
    tokenSecret: process.env.TOKEN_SECRET || 'ab55673b04823925d95e34bb2e3847bd47297ba77c516123deac1c8dcc4f7ea9',
    users: [
      { username: 'nguoithan', password: '123456', role: 'user', fullName: 'Người Thân (Caregiver)' },
      { username: 'admin', password: 'admin123', role: 'admin', fullName: 'Quản Trị Viên (Admin)' }
    ],
    config: {
      emergencyPhone: '0923834966',
      aiThreshold: 0.70
    },
    subscriptions: [
      {
        endpoint: 'https://web.push.apple.com/QNndUC2KRhmTnorPGHlkL7Z6l46DCmmivq1hNp8qR8J0W7beX5IhYcpZGq-EODlOFksj1DFISJqrNNqMKO1fZQtH_YqwiFt8mg7YKFJutRXRV46fNYf9sSs3vAp-p4Ce7SYUEsvunpn3gn1SmnrwX430Tl6ZICe4-_n4ODOTK20',
        keys: {
          p256dh: 'BBgpXqJRRmn0m01RE7Kj0IcUnjc7GaegJFVRIhOPHS1rwPM95ynl_DP8OyN_sgb5uRiIkPJfyYU7GFkIpgLzYeQ',
          auth: 'p26rInRqRdff_2t-Tm94Og'
        }
      }
    ],
    history: []
  };
  fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2));
  return initial;
}

const store = loadStore();

function saveStore() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

webpush.setVapidDetails(
  'mailto:safeguard.tdtu@gmail.com',
  store.vapidKeys.publicKey,
  store.vapidKeys.privateKey
);

let beltState = {
  status: 'DUNG / NGOI YEN',
  is_fallen: false,
  acc: 9.80,
  std: 0.00,
  ai: 0.00,
  buzzer: false,
  lastHeartbeat: 0,
  lastSeenTime: null,
  resetRequested: false
};

let lastFallPushSentAt = 0;

function createToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', store.tokenSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', store.tokenSecret).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (Date.now() >= payload.expiresAt) {
      return { expired: true, payload };
    }
    return { expired: false, payload };
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const result = verifyToken(token);
  if (!result) {
    return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên không hợp lệ', code: 'INVALID_TOKEN' });
  }
  if (result.expired) {
    return res.status(401).json({ error: 'Phiên đăng nhập 24 giờ đã hết hạn. Vui lòng đăng nhập lại.', code: 'SESSION_EXPIRED' });
  }
  req.user = result.payload;
  next();
}

async function broadcastPushNotification(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const validSubs = [];

  for (const sub of store.subscriptions) {
    try {
      await webpush.sendNotification(sub, payload, {
        TTL: 120,
        urgency: 'high'
      });
      validSubs.push(sub);
    } catch (err) {
      // 404 hoặc 410 nghĩa là iPhone đã xóa app hoặc hủy đăng ký trên APNs
      if (err.statusCode !== 404 && err.statusCode !== 410) {
        validSubs.push(sub);
      }
    }
  }

  if (validSubs.length !== store.subscriptions.length) {
    store.subscriptions = validSubs;
    saveStore();
  }
}

function addHistoryEvent(type, message) {
  store.history.unshift({
    id: Date.now(),
    type,
    message,
    time: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
  });
  if (store.history.length > 25) store.history.pop();
  saveStore();
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(
    u => u.username.toLowerCase() === String(username || '').trim().toLowerCase() && u.password === String(password || '')
  );

  if (!user) {
    return res.status(401).json({ error: 'Sai tên tài khoản hoặc mật khẩu!' });
  }

  const loginTime = Date.now();
  const expiresAt = loginTime + SESSION_TTL_MS;
  const token = createToken({
    username: user.username,
    role: user.role,
    fullName: user.fullName,
    loginTime,
    expiresAt
  });

  res.json({
    token,
    user: {
      username: user.username,
      role: user.role,
      fullName: user.fullName
    },
    loginTime,
    expiresAt
  });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Public key VAPID để Service Worker đăng ký với Apple Push Notification service (APNs)
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: store.vapidKeys.publicKey });
});

// Lưu PushSubscription cố định trên Server (không bị xóa khi hết hạn 24h)
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Thiếu thông tin PushSubscription' });
  }

  const exists = store.subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    store.subscriptions.push(subscription);
    saveStore();
  }
  res.json({ ok: true, count: store.subscriptions.length });
});

// Khi người dùng chủ động bấm "Đăng xuất" (trường hợp mượn máy), xóa thiết bị khỏi danh sách nhận thông báo
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    store.subscriptions = store.subscriptions.filter(s => s.endpoint !== endpoint);
    saveStore();
  }
  res.json({ ok: true });
});

// Nút kiểm thử thông báo đẩy chạy nền (trì hoãn 5s để người dùng kịp thoát app ra màn hình chính/game/Facebook)
app.post('/api/push/test', requireAuth, (req, res) => {
  const delayMs = Number(req.body?.delayMs) || 5000;
  setTimeout(() => {
    broadcastPushNotification({
      title: '🚨 KHẨN CẤP: PHÁT HIỆN TÉ NGÃ!',
      body: 'Người thân đeo đai vừa bị ngã và đang nằm bất động! Chạm để mở SafeGuard.',
      tag: 'safeguard-fall-alert',
      timestamp: Date.now()
    });
  }, delayMs);
  res.json({ ok: true, message: `Sẽ đẩy thông báo sau ${delayMs / 1000} giây` });
});

// Endpoint dành cho mạch đai lưng ESP32 gửi dữ liệu lên mỗi 0.5s
app.post('/api/esp32/telemetry', (req, res) => {
  const d = req.body || {};
  const wasFallen = beltState.is_fallen;

  beltState.status = d.status || 'DUNG / NGOI YEN';
  beltState.is_fallen = Boolean(d.is_fallen);
  beltState.acc = typeof d.acc === 'number' ? d.acc : parseFloat(d.acc) || 9.8;
  beltState.std = typeof d.std === 'number' ? d.std : parseFloat(d.std) || 0.0;
  beltState.ai = typeof d.ai === 'number' ? d.ai : parseFloat(d.ai) || 0.0;
  beltState.buzzer = Boolean(d.buzzer);
  beltState.lastHeartbeat = Date.now();
  beltState.lastSeenTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  if (beltState.is_fallen && (!wasFallen || Date.now() - lastFallPushSentAt > 15000)) {
    lastFallPushSentAt = Date.now();
    addHistoryEvent('FALL', `Phát hiện TÉ NGÃ (Gia tốc: ${beltState.acc.toFixed(1)} m/s², AI: ${Math.round(beltState.ai * 100)}%)`);
    broadcastPushNotification({
      title: '🚨 CẢNH BÁO TÉ NGÃ KHẨN CẤP!',
      body: `Người thân đeo đai bị TÉ NGÃ! (Gia tốc: ${beltState.acc.toFixed(1)} m/s², AI: ${Math.round(beltState.ai * 100)}%). Chạm để kiểm tra ngay!`,
      tag: 'safeguard-fall-alert',
      timestamp: Date.now()
    });
  }

  const shouldReset = beltState.resetRequested;
  if (shouldReset) {
    beltState.resetRequested = false;
    beltState.is_fallen = false;
  }

  res.json({
    ok: true,
    reset: shouldReset,
    emergency_phone: store.config.emergencyPhone,
    ai_threshold: store.config.aiThreshold
  });
});

app.get('/api/status', requireAuth, (req, res) => {
  const isOnline = beltState.lastHeartbeat > 0 && (Date.now() - beltState.lastHeartbeat < OFFLINE_TIMEOUT_MS);
  res.json({
    online: isOnline,
    lastSeen: beltState.lastSeenTime || 'Chưa kết nối',
    status: beltState.status,
    is_fallen: beltState.is_fallen,
    acc: beltState.acc,
    std: beltState.std,
    ai: beltState.ai,
    buzzer: beltState.buzzer,
    config: store.config,
    history: store.history,
    pushSubscribedCount: store.subscriptions.length
  });
});

app.post('/api/reset', requireAuth, (req, res) => {
  beltState.is_fallen = false;
  beltState.status = 'DUNG / NGOI YEN';
  beltState.resetRequested = true;
  addHistoryEvent('SAFE', `${req.user.fullName} đã xác nhận an toàn / tắt báo động.`);
  res.json({ status: 'ok' });
});

app.post('/api/admin/config', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ Quản trị viên (Admin) mới có quyền thay đổi cấu hình!' });
  }
  const { emergencyPhone, aiThreshold } = req.body || {};
  if (emergencyPhone) store.config.emergencyPhone = String(emergencyPhone).trim();
  if (aiThreshold !== undefined) {
    const val = parseFloat(aiThreshold);
    if (!isNaN(val) && val >= 0.3 && val <= 0.99) {
      store.config.aiThreshold = val;
    }
  }
  saveStore();
  addHistoryEvent('CONFIG', `Admin cập nhật SĐT SMS: ${store.config.emergencyPhone}, Ngưỡng AI: ${Math.round(store.config.aiThreshold * 100)}%`);
  res.json({ ok: true, config: store.config });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  SAFEGUARD SERVER DANG CHAY TAI PORT: ${PORT}`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
