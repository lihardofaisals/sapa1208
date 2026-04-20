import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import cron from "node-cron";
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  delay
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { format, isWeekend, addDays, startOfMonth, endOfMonth, eachDayOfInterval, parseISO } from "date-fns";
import { toZonedTime, format as formatTZ } from "date-fns-tz";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Setup ---
const db = new Database("database.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE,
    is_workday INTEGER,
    holiday_name TEXT,
    source TEXT DEFAULT 'auto' -- 'auto' or 'manual'
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    datetime TEXT,
    type TEXT,
    status TEXT,
    message TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  
  -- Migration: Ensure holiday_name exists in calendar
  -- SQLite doesn't support IF NOT EXISTS in ALTER TABLE directly, so we check existence
  PRAGMA table_info(calendar);
`);

// Manual migration for older DBs
const calendarColumns = db.pragma("table_info(calendar)") as any[];
if (!calendarColumns.some(c => c.name === "holiday_name")) {
  try { db.exec("ALTER TABLE calendar ADD COLUMN holiday_name TEXT;"); } catch (e) {}
}
if (!calendarColumns.some(c => c.name === "source")) {
  try { db.exec("ALTER TABLE calendar ADD COLUMN source TEXT DEFAULT 'auto';"); } catch (e) {}
}

db.exec(`
  INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_quote', 'Semangat kerja untuk hari ini!');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('quote_date', '');
`);

// Initialize settings if not exists
const initSettings = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
initSettings.run("group_id", "");
initSettings.run("morning_time", "07:30");
initSettings.run("afternoon_time", "16:30");
initSettings.run("morning_msg", "⏰ Reminder Presensi\nSelamat pagi, jangan lupa melakukan presensi masuk sebelum jam 08.00\nTerima kasih");
initSettings.run("afternoon_msg", "⏰ Reminder Presensi\nJangan lupa melakukan presensi pulang sebelum jam 17.00\nTerima kasih");
initSettings.run("last_detected_group", "");
initSettings.run("timezone", "Asia/Jakarta");

const getSetting = (key: string) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
const setSetting = (key: string, value: string) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);

// Indonesian Holidays Sync (Google Calendar API & Fallback)
async function syncIndonesianHolidays() {
  try {
    const tz = getSetting("timezone")?.value || "Asia/Jakarta";
    const now = dayjs().tz(tz);
    const currentYear = now.year();
    const lastSync = getSetting("last_holiday_sync")?.value;
    const currentMonth = now.format("YYYY-MM");
    
    if (lastSync === currentMonth) {
      console.log("Holidays already synced this month.");
      return;
    }

    let holidays: any[] = [];
    const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
    const calendarId = "id.indonesian#holiday@group.v.calendar.google.com";

    if (apiKey) {
      console.log("Syncing from Google Calendar API...");
      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${apiKey}&timeMin=${currentYear}-01-01T00:00:00Z&timeMax=${currentYear}-12-31T23:59:59Z&singleEvents=true`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.items) {
          holidays = data.items.map((item: any) => ({
            date: item.start.date || item.start.dateTime.split("T")[0],
            name: item.summary
          }));
        }
      } catch (err) {
        console.error("Google Calendar API failed, falling back...", err);
      }
    }

    if (holidays.length === 0) {
      console.log("Syncing from Fallback API...");
      try {
        const res = await fetch(`https://dayoffapi.vercel.app/api?year=${currentYear}`);
        const data = await res.json();
        holidays = data.map((h: any) => ({
          date: h.holiday_date || h.date,
          name: h.holiday_name || h.name
        }));
      } catch (err) {}
    }

    // Safety check for common holidays if list is still small or incomplete
    if (holidays.length > 0 && !holidays.some(h => h.date === `${currentYear}-12-25`)) {
      holidays.push({ date: `${currentYear}-12-25`, name: "Hari Raya Natal" });
    }

    const upsertStmt = db.prepare("INSERT INTO calendar (date, is_workday, holiday_name, source) VALUES (?, 0, ?, 'auto') ON CONFLICT(date) DO UPDATE SET holiday_name = excluded.holiday_name, is_workday = 0 WHERE source = 'auto'");
    
    let count = 0;
    for (const h of holidays) {
      const date = h.date;
      const name = h.name;
      if (date) {
        const dStr = date.includes("T") ? date.split("T")[0] : date;
        const result = upsertStmt.run(dStr, name || "Hari Libur Nasional");
        if (result.changes > 0) count++;
      }
    }

    setSetting("last_holiday_sync", currentMonth);
    console.log(`Synced ${count} holidays for ${currentYear}`);
  } catch (err) {
    console.error("Holiday sync error:", err);
  }
}

// --- WhatsApp Logic ---
let sock: any = null;
let qrCode: string | null = null;
let connectionStatus: "connecting" | "open" | "close" | "qr" = "connecting";

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
    browser: ["PresensiBot", "MacOS", "1.0.0"],
    syncFullHistory: false,
  });

  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = "qr";
    }

    if (connection === "close") {
      connectionStatus = "close";
      qrCode = null;
      
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log("Connection closed. Reason:", error?.message, "Status Code:", statusCode, "Should reconnect:", shouldReconnect);
      
      if (shouldReconnect) {
        // Handle specific errors with custom delays
        // 408: Request Timeout, 515: Stream Errored (Restart Required)
        let delayMs = 2000;
        if (statusCode === 408) delayMs = 5000;
        if (statusCode === 515) {
          console.log("Stream Errored detected (515). Performing a fresh restart...");
          delayMs = 3000;
        }
        
        console.log(`Reconnecting in ${delayMs}ms...`);
        setTimeout(connectToWhatsApp, delayMs);
      } else {
        console.log("Logged out. Please scan QR again.");
      }
    } else if (connection === "open") {
      console.log("WhatsApp connection opened successfully");
      connectionStatus = "open";
      qrCode = null;
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Listen for messages to help user find group ID
  sock.ev.on("messages.upsert", async (m: any) => {
    const msg = m.messages[0];
    console.log(`[BOT] New message received from: ${msg.key.remoteJid}`);
    
    if (!msg.key.fromMe && msg.key.remoteJid?.endsWith("@g.us")) {
      console.log(`[BOT] Activity detected in group: ${msg.key.remoteJid}`);
      setSetting("last_detected_group", msg.key.remoteJid);
    }
  });
}

// --- Reminder Logic ---
function getNextReminder() {
  const tz = getSetting("timezone")?.value || "Asia/Jakarta";
  const morningTime = getSetting("morning_time")?.value || "07:30";
  const afternoonTime = getSetting("afternoon_time")?.value || "16:30";
  
  const now = dayjs().tz(tz);
  let checkDay = now;
  
  for (let i = 0; i < 30; i++) {
    const dateStr = checkDay.format("YYYY-MM-DD");
    const record = db.prepare("SELECT is_workday FROM calendar WHERE date = ?").get(dateStr) as { is_workday: number } | undefined;
    
    let isWorkday: boolean;
    if (record) {
      isWorkday = record.is_workday === 1;
    } else {
      const dayOfWeek = checkDay.day();
      isWorkday = dayOfWeek !== 0 && dayOfWeek !== 6;
    }

    if (isWorkday) {
      const schedules = [
        { time: morningTime, type: "Pagi" },
        { time: afternoonTime, type: "Sore" }
      ];
      
      for (const s of schedules) {
        const [h, m] = s.time.split(":").map(Number);
        const reminderTime = checkDay.hour(h).minute(m).second(0);
        
        if (reminderTime.isAfter(now)) {
          let dayLabel = "Hari Ini";
          if (!checkDay.isSame(now, 'day')) {
             if (checkDay.isSame(now.add(1, 'day'), 'day')) dayLabel = "Besok";
             else dayLabel = checkDay.format("DD MMM");
          }
          
          return {
            time: s.time,
            type: s.type,
            day: dayLabel,
            fullDate: dateStr
          };
        }
      }
    }
    checkDay = checkDay.add(1, 'day').hour(0).minute(0).second(0);
  }
  return null;
}

async function sendReminder(type: "morning" | "afternoon") {
  const tz = getSetting("timezone")?.value || "Asia/Jakarta";
  const now = dayjs().tz(tz);
  const today = now.format("YYYY-MM-DD");
  
  // Check if it's a workday (Priority: Manual > Sync > Weekend)
  const record = db.prepare("SELECT is_workday FROM calendar WHERE date = ?").get(today) as { is_workday: number } | undefined;
  
  let isWorkday: boolean;
  if (record) {
    isWorkday = record.is_workday === 1;
  } else {
    const dayOfWeek = now.day();
    isWorkday = dayOfWeek !== 0 && dayOfWeek !== 6; // Mon-Fri
  }

  if (!isWorkday) {
    console.log(`Skipping ${type} reminder for ${today} (Not a workday)`);
    return;
  }

  const groupId = getSetting("group_id")?.value;
  if (!groupId) {
    db.prepare("INSERT INTO logs (datetime, type, status, message) VALUES (?, ?, ?, ?)").run(
      new Date().toISOString(), type, "failed", "Group ID not set"
    );
    return;
  }

  if (connectionStatus !== "open") {
    db.prepare("INSERT INTO logs (datetime, type, status, message) VALUES (?, ?, ?, ?)").run(
      new Date().toISOString(), type, "failed", "WhatsApp not connected"
    );
    return;
  }

  let message = getSetting(type === "morning" ? "morning_msg" : "afternoon_msg")?.value || "";

  // Add Quote of the Day (retrieved from settings)
  const quote = getSetting("daily_quote")?.value;
  if (quote) {
    message += `\n\n💡 *Quote of the Day:*\n_${quote}_`;
  }

  try {
    const mentions = [];
    if (/@semua|@everyone/i.test(message)) {
      console.log(`Tagging all participants in group: ${groupId}`);
      const metadata = await sock.groupMetadata(groupId);
      mentions.push(...metadata.participants.map((p: any) => p.id));
      console.log(`Mentioning ${mentions.length} participants`);
    }

    await sock.sendMessage(groupId, { text: message, mentions });
    db.prepare("INSERT INTO logs (datetime, type, status, message) VALUES (?, ?, ?, ?)").run(
      new Date().toISOString(), type, "success", "Message sent successfully"
    );
  } catch (error: any) {
    db.prepare("INSERT INTO logs (datetime, type, status, message) VALUES (?, ?, ?, ?)").run(
      new Date().toISOString(), type, "failed", error.message || "Unknown error"
    );
  }
}

// --- Scheduler ---
function startScheduler() {
  const tz = getSetting("timezone")?.value || "Asia/Jakarta";
  console.log(`Starting scheduler with timezone: ${tz}`);
  
  cron.schedule("* * * * *", () => {
    const currentTz = getSetting("timezone")?.value || "Asia/Jakarta";
    const now = dayjs().tz(currentTz);
    const nowTime = now.format("HH:mm");
    
    const morningTime = getSetting("morning_time")?.value;
    const afternoonTime = getSetting("afternoon_time")?.value;

    if (nowTime === morningTime) {
      console.log(`Triggering morning reminder at ${nowTime}`);
      sendReminder("morning");
    }
    if (nowTime === afternoonTime) {
      console.log(`Triggering afternoon reminder at ${nowTime}`);
      sendReminder("afternoon");
    }
  }, {
    timezone: tz as any
  });

  // Auto-sync holidays every 24 hours at 01:00
  cron.schedule("0 1 * * *", () => {
    syncIndonesianHolidays();
  }, {
    timezone: tz as any
  });
}

// --- Server Setup ---
async function startServer() {
  const app = express();
  app.use(express.json());

  const ADMIN_PASSWORD = "admin123";
  const AUTH_TOKEN = "sapa_auth_token_v1_bps_asahan";

  // Auth Middleware
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers["x-sapa-auth"];
    if (authHeader === AUTH_TOKEN) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  };

  // --- API Routes ---
  
  // Auth routes (public)
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    console.log(`Login attempt with password: [${password}]`);
    if (password && password.trim() === ADMIN_PASSWORD) {
      console.log("Login successful");
      return res.json({ success: true, token: AUTH_TOKEN });
    } else {
      console.log("Login failed: Invalid password");
      return res.status(401).json({ error: "Invalid password" });
    }
  });

  app.post("/api/logout", (req, res) => {
    return res.json({ success: true });
  });

  app.get("/api/auth/status", (req, res) => {
    const authHeader = req.headers["x-sapa-auth"];
    res.json({ authenticated: authHeader === AUTH_TOKEN });
  });

  // Protected routes
  app.use("/api", (req, res, next) => {
    // Whitelist public API paths
    const publicPaths = ["/login", "/logout", "/auth/status", "/time"];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    
    // Header-based auth check
    const authHeader = req.headers["x-sapa-auth"];
    if (authHeader === AUTH_TOKEN) {
      next();
    } else {
      console.log(`Unauthorized access attempt to: ${req.path} (Token: ${authHeader})`);
      res.status(401).json({ error: "Unauthorized" });
    }
  });
  
  // Status info
  app.get("/api/status", (req, res) => {
    res.json({
      connectionStatus,
      qrCode,
      next_reminder: getNextReminder(),
      settings: {
        group_id: getSetting("group_id")?.value,
        morning_time: getSetting("morning_time")?.value,
        afternoon_time: getSetting("afternoon_time")?.value,
        morning_msg: getSetting("morning_msg")?.value,
        afternoon_msg: getSetting("afternoon_msg")?.value,
        last_detected_group: getSetting("last_detected_group")?.value,
        daily_quote: getSetting("daily_quote")?.value,
        quote_date: getSetting("quote_date")?.value,
        last_holiday_sync: getSetting("last_holiday_sync")?.value,
        timezone: getSetting("timezone")?.value,
      }
    });
  });

  app.get("/api/time", (req, res) => {
    const tz = getSetting("timezone")?.value || "Asia/Jakarta";
    const now = dayjs().tz(tz);
    res.json({
      server_time: dayjs().utc().format("YYYY-MM-DD HH:mm:ss"),
      zoned_time: now.format("YYYY-MM-DD HH:mm:ss"),
      timezone: tz
    });
  });

  // Logs
  app.get("/api/logs", (req, res) => {
    const logs = db.prepare("SELECT * FROM logs ORDER BY datetime DESC LIMIT 50").all();
    res.json(logs);
  });

  // Calendar
  app.get("/api/calendar", (req, res) => {
    const monthStr = req.query.month as string; // YYYY-MM
    if (!monthStr) return res.status(400).json({ error: "Month required" });

    const tz = getSetting("timezone")?.value || "Asia/Jakarta";
    const [year, month] = monthStr.split("-").map(Number);
    const startDay = dayjs.tz(`${year}-${month.toString().padStart(2, '0')}-01`, tz).startOf('month');
    const daysInMonth = startDay.daysInMonth();
    
    const results = [];
    const nowZoned = dayjs().tz(tz);

    for (let i = 1; i <= daysInMonth; i++) {
        const currentDay = startDay.date(i);
        const dateStr = currentDay.format("YYYY-MM-DD");
        const record = db.prepare("SELECT is_workday, holiday_name, source FROM calendar WHERE date = ?").get(dateStr) as { is_workday: number, holiday_name: string | null, source: string } | undefined;
        
        const dayOfWeek = currentDay.day(); // 0 = Sunday, 6 = Saturday
        const isWeekendDay = dayOfWeek === 0 || dayOfWeek === 6;
        
        let isWorkday: boolean;
        let label = "";
        let source = "default";

        // Priority Logic:
        // 1. Manual User Override (source = 'manual')
        // 2. Synced Holiday (source = 'auto' and is_workday = 0)
        // 3. Weekend (Sat/Sun)
        // 4. Default Workday (Mon-Fri)

        if (record && record.source === 'manual') {
            isWorkday = record.is_workday === 1;
            label = record.holiday_name || (isWorkday ? "" : "Manual Override");
            source = "manual";
        } else if (record && record.source === 'auto' && record.is_workday === 0) {
            isWorkday = false;
            label = record.holiday_name || "Hari Libur";
            source = "auto";
        } else {
            isWorkday = !isWeekendDay;
            label = isWeekendDay ? "Weekend" : "";
            source = "default";
        }

        results.push({
            date: dateStr,
            isWorkday,
            isOverwritten: !!record,
            holidayName: label,
            source: source,
            isPast: currentDay.isBefore(nowZoned, 'day'),
            dayOfWeek
        });
    }

    res.json(results);
  });

  app.post("/api/calendar/toggle", (req, res) => {
    const { date, isWorkday } = req.body;
    db.prepare("INSERT OR REPLACE INTO calendar (date, is_workday, holiday_name, source) VALUES (?, ?, ?, 'manual')").run(date, isWorkday ? 1 : 0, isWorkday ? "" : "Manual Override");
    res.json({ success: true });
  });

  app.post("/api/calendar/reset", (req, res) => {
    db.prepare("DELETE FROM calendar WHERE source = 'manual'").run();
    res.json({ success: true });
  });

  app.post("/api/calendar/sync-holidays", async (req, res) => {
    // Force sync by clearing the last_holiday_sync setting before running
    setSetting("last_holiday_sync", "");
    await syncIndonesianHolidays();
    res.json({ success: true });
  });

  // Update settings
  app.post("/api/settings", (req, res) => {
    const { group_id, morning_time, afternoon_time, morning_msg, afternoon_msg, daily_quote, quote_date } = req.body;
    if (group_id !== undefined) setSetting("group_id", group_id);
    if (morning_time !== undefined) setSetting("morning_time", morning_time);
    if (afternoon_time !== undefined) setSetting("afternoon_time", afternoon_time);
    if (morning_msg !== undefined) setSetting("morning_msg", morning_msg);
    if (afternoon_msg !== undefined) setSetting("afternoon_msg", afternoon_msg);
    if (daily_quote !== undefined) setSetting("daily_quote", daily_quote);
    if (quote_date !== undefined) setSetting("quote_date", quote_date);
    res.json({ success: true });
  });

  // Test sending
  app.post("/api/test-send", async (req, res) => {
    const { type } = req.body;
    await sendReminder(type);
    res.json({ success: true });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });

  // Initialize WhatsApp, Scheduler and Holidays
  syncIndonesianHolidays();
  connectToWhatsApp();
  startScheduler();
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
