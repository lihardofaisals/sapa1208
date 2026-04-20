/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { 
  Calendar as CalendarIcon, 
  Settings as SettingsIcon, 
  Activity, 
  MessageSquare, 
  Smartphone, 
  Clock, 
  Send, 
  CheckCircle2, 
  XCircle, 
  RefreshCw,
  Info,
  ChevronLeft,
  ChevronRight,
  Lock,
  LogOut
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI } from "@google/genai";
import { 
  format, 
  addMonths, 
  subMonths, 
  startOfMonth, 
  endOfMonth, 
  eachDayOfInterval, 
  isSameMonth, 
  isToday,
  parseISO
} from "date-fns";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Tab = "dashboard" | "calendar" | "settings" | "logs";

interface SettingState {
  group_id: string;
  morning_time: string;
  afternoon_time: string;
  morning_msg: string;
  afternoon_msg: string;
  last_detected_group?: string;
  daily_quote?: string;
  quote_date?: string;
  last_holiday_sync?: string;
  timezone: string;
}

interface LogEntry {
  id: number;
  datetime: string;
  type: string;
  status: string;
  message: string;
}

interface CalendarDay {
  date: string;
  isWorkday: boolean;
  isOverwritten: boolean;
  holidayName?: string | null;
  source: string;
  isPast: boolean;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [status, setStatus] = useState<any>(null);
  const [serverTime, setServerTime] = useState<{ server_time: string; zoned_time: string; timezone: string } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [calendar, setCalendar] = useState<(CalendarDay | null)[]>([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [settings, setSettings] = useState<SettingState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ date: string; isWorkday: boolean; holidayName: string } | null>(null);

  const showNotification = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const token = localStorage.getItem("sapa_token");
    const headers = {
      ...options.headers,
      "x-sapa-auth": token || "",
    };
    return fetch(url, { ...options, headers });
  };

  const updateDailyQuote = async (currentSettings: SettingState) => {
    const today = format(new Date(), "yyyy-MM-dd");
    if (currentSettings.quote_date === today) return;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: "Berikan satu kutipan motivasi kerja singkat dalam bahasa Indonesia untuk menyemangati hari. Berikan kutipan langsung beserta pencetusnya jika ada. Contoh: 'Satu-satunya cara untuk melakukan pekerjaan hebat adalah dengan mencintai apa yang Anda lakukan. - Steve Jobs'. Berikan teks bersih tanpa tanda kutip pembungkus tambahan.",
      });
      const quote = response.text?.trim();
      if (quote) {
        await apiFetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ daily_quote: quote, quote_date: today })
        });
        console.log("Daily quote updated:", quote);
      }
    } catch (err) {
      console.error("Gemini frontend error:", err);
    }
  };

  const fetchData = async () => {
    try {
      const statusRes = await apiFetch("/api/status");
      if (statusRes.status === 401) {
        setIsAuthenticated(false);
        return;
      }
      const statusData = await statusRes.json();
      setStatus(statusData);
      
      // Only update settings from server if not currently on settings tab to avoid overwriting user input
      if (activeTab !== "settings") {
        setSettings(statusData.settings);
      }
      
      if (statusData.settings) {
        updateDailyQuote(statusData.settings);
      }

      const logsRes = await apiFetch("/api/logs");
      const logsData = await logsRes.json();
      setLogs(logsData);

      const monthStr = format(currentMonth, "yyyy-MM");
      const calendarRes = await apiFetch(`/api/calendar?month=${monthStr}`);
      const calendarData = await calendarRes.json();
      
      // Pad calendar to align with correct day of week (Monday start)
      const firstDayOfMonth = startOfMonth(parseISO(monthStr + "-01"));
      // getDay() returns 0 for Sunday, 1 for Monday...
      // We want 0 for Monday, 1 for Tuesday... 6 for Sunday (since our grid starts with Sen/Mon)
      let startDayIdx = firstDayOfMonth.getDay() - 1;
      if (startDayIdx === -1) startDayIdx = 6; // Sunday becomes 6
      
      const paddedCalendar = [
        ...Array(startDayIdx).fill(null),
        ...calendarData
      ];
      setCalendar(paddedCalendar);
    } catch (err) {
      console.error("Fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  };


  const toggleWorkday = async (date: string, currentStatus: boolean) => {
    try {
      showNotification("Memproses perubahan...", "success");
      await apiFetch("/api/calendar/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, isWorkday: !currentStatus })
      });
      fetchData();
      showNotification(`Status tanggal ${date} telah diperbarui`, "success");
      setConfirmModal(null);
    } catch (err) {
      console.error(err);
      showNotification("Gagal mengubah status tanggal.", "error");
    }
  };

  const syncHolidays = async () => {
    try {
      showNotification("Sinkronisasi Hari Libur...", "success");
      await apiFetch("/api/calendar/sync-holidays", { method: "POST" });
      fetchData();
      showNotification("Sinkronisasi Google Calendar Berhasil", "success");
    } catch (err) {
       showNotification("Gagal sinkronisasi", "error");
    }
  };

  const resetCalendar = async () => {
    if (!confirm("Anda yakin ingin menghapus semua pengaturan manual kalender? Kalender akan dikembalikan ke setelan default (Sabtu/Minggu libur).")) return;
    try {
      showNotification("Mereset kalender...", "success");
      await apiFetch("/api/calendar/reset", { method: "POST" });
      fetchData();
      showNotification("Kalender berhasil direset.", "success");
    } catch (err) {
      console.error(err);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    try {
      const res = await apiFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      if (res.status === 401) {
        setIsAuthenticated(false);
        return;
      }
      showNotification("Pengaturan berhasil disimpan!", "success");
    } catch (err) {
      console.error(err);
      showNotification("Gagal menyimpan pengaturan.", "error");
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginPassword) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword })
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem("sapa_token", data.token);
        setIsAuthenticated(true);
      } else {
        setLoginError("Password yang Anda masukkan salah.");
        showNotification("Password salah!", "error");
        setLoginPassword(""); // Clear password on error
      }
    } catch (err) {
      setLoginError("Terjadi gangguan koneksi ke server.");
      showNotification("Terjadi kesalahan login", "error");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch("/api/logout", { method: "POST" });
      localStorage.removeItem("sapa_token");
      setIsAuthenticated(false);
      setStatus(null);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await apiFetch("/api/auth/status");
        const data = await res.json();
        setIsAuthenticated(data.authenticated);
      } catch (err) {
        setIsAuthenticated(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    if (isAuthenticated === true) {
      fetchData();
      const interval = setInterval(fetchData, 3000); // Poll every 3s
      return () => clearInterval(interval);
    }
  }, [currentMonth, activeTab, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated === true) {
      const timeInterval = setInterval(async () => {
        try {
          const timeRes = await apiFetch("/api/time");
          const timeData = await timeRes.json();
          setServerTime(timeData);
        } catch (err) {
          console.error("Time sync error:", err);
        }
      }, 1000);
      return () => clearInterval(timeInterval);
    }
  }, [isAuthenticated]);

  const testSend = async (type: "morning" | "afternoon") => {
    try {
      await apiFetch("/api/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type })
      });
      alert("Test request sent!");
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const isDayToday = (dateStr: string) => {
    if (!serverTime) return isToday(parseISO(dateStr));
    const todayStr = serverTime.zoned_time.split(" ")[0];
    return dateStr === todayStr;
  };

  if (isAuthenticated === false) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-6 bg-gradient-to-br from-bg via-bg to-brand/5">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-surface p-10 rounded-[32px] border border-border shadow-2xl shadow-brand/10 border-white/40"
        >
          <div className="flex flex-col items-center text-center mb-10">
            <div className="w-20 h-20 bg-accent/10 rounded-3xl flex items-center justify-center text-accent mb-6 shadow-inner">
              <Lock className="w-10 h-10" />
            </div>
            <h1 className="text-3xl font-black tracking-tight text-accent mb-2">Akses Terbatas</h1>
            <p className="text-text-muted text-[11px] font-bold uppercase tracking-wider">Sistem Alarm Presensi BPS Asahan (SAPA)</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <motion.div 
              animate={loginError ? { x: [-10, 10, -10, 10, 0] } : {}}
              className="space-y-2"
            >
              <label className="text-xs font-black uppercase tracking-widest text-text-muted px-1">Admin Password</label>
              <div className="relative">
                <input 
                  type="password"
                  value={loginPassword}
                  onChange={(e) => {
                    setLoginPassword(e.target.value);
                    if (loginError) setLoginError(null);
                  }}
                  placeholder="Masukkan password..."
                  className={cn(
                    "w-full px-6 py-4 bg-bg border-2 rounded-2xl outline-none transition-all font-bold tracking-widest text-lg",
                    loginError ? "border-danger text-danger bg-danger/5" : "border-border focus:border-accent"
                  )}
                  autoFocus
                />
                {loginError && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute -bottom-6 left-1 text-[10px] font-bold text-danger uppercase tracking-wider"
                  >
                    {loginError}
                  </motion.div>
                )}
              </div>
            </motion.div>
            <button 
              type="submit"
              disabled={isLoggingIn}
              className="w-full py-5 bg-accent text-white rounded-2xl font-black text-lg shadow-lg shadow-accent/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {isLoggingIn ? "Memverifikasi..." : "Masuk Ke Dashboard"}
            </button>
          </form>

          <p className="mt-10 text-center text-[10px] font-bold text-text-muted uppercase tracking-widest pt-6 border-t border-border/50">
            BPS Kabupaten Asahan
          </p>
        </motion.div>
      </div>
    );
  }

  if (isAuthenticated === null || (isLoading && !status)) {
    return (
      <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          <RefreshCw className="w-8 h-8 text-neutral-400" />
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-text-main font-sans">
      {/* Sidebar Navigation */}
      <div className="fixed left-0 top-0 bottom-0 w-[260px] bg-surface border-r border-border p-10 px-6 z-10 hidden md:flex flex-col">
        <div className="flex items-center gap-3 mb-12 px-2">
          <div className="w-12 h-12 bg-accent rounded-xl flex items-center justify-center text-white font-black text-2xl shadow-lg shadow-accent/20">
            S
          </div>
          <div className="flex flex-col">
            <h1 className="font-black text-2xl tracking-tighter leading-none text-accent">SAPA</h1>
            <span className="text-[11px] font-bold text-brand uppercase tracking-wider mt-0.5">BPS KAB. ASAHAN</span>
            <span className="text-[8px] font-bold text-text-muted uppercase tracking-tight leading-tight">Sistem Alarm Presensi BPS Asahan</span>
          </div>
        </div>

        <nav className="flex-1">
          <ul className="space-y-1">
            <NavListItem active={activeTab === "dashboard"} onClick={() => setActiveTab("dashboard")} label="Ringkasan" />
            <NavListItem active={activeTab === "calendar"} onClick={() => setActiveTab("calendar")} label="Kalender Kerja" />
            <NavListItem active={activeTab === "settings"} onClick={() => setActiveTab("settings")} label="Pengaturan" />
            <NavListItem active={activeTab === "logs"} onClick={() => setActiveTab("logs")} label="Log Aktivitas" />
          </ul>
        </nav>

        <div className="mt-auto space-y-4">
          <button 
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-xl text-sm font-bold text-danger hover:bg-danger/5 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>Keluar Sistem</span>
          </button>
          
          <div className="p-5 bg-bg rounded-2xl border border-border">
            <p className="text-[11px] font-bold text-text-muted uppercase tracking-widest mb-1">Status Server</p>
            <div className="flex items-center gap-2">
              <div className={cn(
                "w-2 h-2 rounded-full",
                status?.connectionStatus === "open" ? "bg-accent shadow-[0_0_8px_rgba(34,197,94,0.4)]" : "bg-danger"
              )} />
              <span className="text-sm font-semibold">
                {status?.connectionStatus === "open" ? "Berjalan Normal" : "Terputus"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="md:ml-[260px] p-10 max-w-6xl mx-auto flex flex-col gap-8">
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              key="dashboard"
              className="space-y-8"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <StatCard 
                  label="Status WhatsApp" 
                  value={status?.connectionStatus === "open" ? "Terhubung" : "Terputus"}
                  indicatorColor={status?.connectionStatus === "open" ? "bg-accent" : "bg-danger"}
                  caption={status?.settings?.group_id ? `Monitoring: BPS Kab. Asahan` : "Grup belum diatur"}
                />
                <StatCard 
                  label="Jadwal Berikutnya" 
                  value={status?.next_reminder ? `${status.next_reminder.time}` : "--:--"}
                  unit="WIB"
                  caption={status?.next_reminder ? `${status.next_reminder.day} (${status.next_reminder.type})` : "Tidak ada jadwal"}
                />
                <StatCard 
                  label="Log Hari Ini" 
                  value={logs.filter(l => format(parseISO(l.datetime), "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd")).length.toString()}
                  isDark
                  caption="Total Terkirim"
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 min-h-[400px]">
                {/* QR / Main Status */}
                <div className="lg:col-span-3 bg-surface p-6 rounded-[20px] border border-border flex flex-col items-center justify-center">
                  {status?.connectionStatus === "open" ? (
                    <div className="text-center space-y-4">
                      <div className="bg-accent/10 w-20 h-20 rounded-full flex items-center justify-center mx-auto">
                        <CheckCircle2 className="w-10 h-10 text-accent" />
                      </div>
                      <h3 className="text-2xl font-bold tracking-tight text-accent">SAPA Aktif</h3>
                      <p className="text-text-muted text-sm max-w-xs mx-auto">
                        Selamat datang di Sistem Alarm Presensi BPS Asahan (SAPA). Bot siap beroperasi sesuai jadwal.
                      </p>
                    </div>
                  ) : status?.qrCode ? (
                    <div className="text-center space-y-6 py-6">
                      <h3 className="text-lg font-bold tracking-tight">Scan WhatsApp QR</h3>
                      <div className="bg-white p-4 rounded-2xl border border-border shadow-sm inline-block">
                        <img src={status.qrCode} alt="WhatsApp QR" className="w-56 h-56" />
                      </div>
                      <p className="text-text-muted text-xs max-w-xs mx-auto leading-relaxed">
                        Buka WhatsApp di ponsel, ketuk Menu/Pengaturan dan pilih Perangkat Tertaut.
                      </p>
                    </div>
                  ) : (
                    <div className="text-center space-y-4">
                      <RefreshCw className="w-10 h-10 text-text-muted animate-spin mx-auto" />
                      <p className="text-text-muted font-medium">Mempersiapkan seksi...</p>
                    </div>
                  )}
                </div>

                {/* Recent Logs Summary */}
                <div className="lg:col-span-2 bg-surface p-6 rounded-[20px] border border-border flex flex-col">
                  <div className="flex justify-between items-center mb-6">
                    <h2 className="font-bold">Log Terkini</h2>
                    <button onClick={() => setActiveTab("logs")} className="text-xs font-bold text-text-muted hover:text-text-main transition-colors">LIHAT SEMUA</button>
                  </div>
                  <div className="flex-1 space-y-3">
                    {logs.slice(0, 4).map((log) => (
                      <div key={log.id} className="flex items-center gap-3 py-3 border-b border-border last:border-0 group cursor-default">
                        <span className={cn(
                          "text-[10px] font-extrabold px-2 py-1 rounded-md uppercase tracking-wider",
                          log.type === "morning" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-900"
                        )}>
                          {log.type === "morning" ? "Pagi" : "Sore"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-bold truncate group-hover:text-text-main transition-colors">{log.status === "success" ? "Berhasil Dikirim" : "Gagal Dikirim"}</p>
                          <p className="text-[11px] text-text-muted truncate">{log.message}</p>
                        </div>
                        <span className="text-[11px] font-medium text-text-muted shrink-0">
                          {format(parseISO(log.datetime), "HH:mm")}
                        </span>
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <div className="flex flex-col items-center justify-center flex-1 text-center py-10 opacity-40">
                         <Activity className="w-10 h-10 mb-2" />
                         <p className="text-xs italic">Belum ada aktivitas</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "calendar" && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              key="calendar"
              className="space-y-8"
            >
              <header className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-extrabold tracking-tight">Kalender Kerja</h2>
                  <p className="text-text-muted text-sm">{format(currentMonth, "MMMM yyyy")}</p>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={syncHolidays}
                    title="Sync Google Calendar"
                    className="p-3 bg-surface border border-border rounded-xl hover:bg-bg transition-colors text-text-muted hover:text-brand"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={resetCalendar}
                    title="Reset Kalender"
                    className="p-3 bg-surface border border-border rounded-xl hover:bg-bg transition-colors text-text-muted hover:text-danger"
                  >
                    <Activity className="w-4 h-4" />
                  </button>
                  <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-3 bg-surface border border-border rounded-xl hover:bg-bg transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-3 bg-surface border border-border rounded-xl hover:bg-bg transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </header>

              <div className="bg-surface p-6 rounded-[20px] border border-border">
                <div className="grid grid-cols-7 gap-4 mb-4">
                  {["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"].map(d => (
                    <div key={d} className="text-[11px] font-bold text-text-muted uppercase text-center tracking-widest">{d}</div>
                  ))}
                </div>
                 <div className="grid grid-cols-7 gap-4">
                  {calendar.map((day, idx) => {
                    if (!day) return <div key={`empty-${idx}`} className="aspect-square" />;
                    
                    const isTodayLocal = isDayToday(day.date);
                    const isLibur = !day.isWorkday;
                    
                    return (
                      <button
                        key={day.date}
                        onClick={() => setConfirmModal({ date: day.date, isWorkday: day.isWorkday, holidayName: day.holidayName || "" })}
                        onDoubleClick={() => toggleWorkday(day.date, day.isWorkday)}
                        className={cn(
                          "aspect-square rounded-2xl border flex flex-col items-center justify-center p-2 gap-0.5 transition-all active:scale-95 text-sm relative overflow-hidden",
                          isLibur 
                            ? "bg-danger/5 text-danger border-danger/20 hover:border-danger font-bold"
                            : "bg-success/5 text-success border-success/20 hover:border-accent font-semibold",
                          day.isPast && "grayscale opacity-50 bg-bg text-text-muted border-border",
                          isTodayLocal && "ring-2 ring-brand ring-offset-2 border-brand"
                        )}
                      >
                        <span className="text-lg">{format(parseISO(day.date), "d")}</span>
                        {day.holidayName && (
                          <span className={cn(
                            "text-[8px] leading-tight text-center font-bold px-1 line-clamp-2 uppercase tracking-tighter",
                            isLibur ? "text-danger" : "text-success"
                          )}>
                            {day.holidayName}
                          </span>
                        )}
                        {day.source === 'manual' && (
                           <div className="absolute top-1 left-1 w-1.5 h-1.5 rounded-full bg-brand" title="Manual Override" />
                        )}
                        {isTodayLocal && (
                           <div className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-brand shadow-sm border-2 border-white animate-pulse" />
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-6 p-6 bg-surface rounded-[24px] border border-border shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded-md bg-success/10 border border-success/30" />
                    <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Hari Kerja</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded-md bg-danger/10 border border-danger/30" />
                    <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Hari Libur</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-brand" />
                    <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Manual Edit</span>
                  </div>
                  <div className="flex items-center gap-3 opacity-50 grayscale">
                    <div className="w-4 h-4 rounded-md bg-bg border border-border" />
                    <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Tanggal Lewat</span>
                  </div>
                </div>

                <div className="mt-8 flex justify-center gap-6 text-[11px] font-bold text-text-muted uppercase tracking-widest pt-6 border-t border-border">
                  <div className="flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5" />
                    <span>Klik tanggal untuk ubah status</span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "settings" && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              key="settings"
              className="space-y-8"
            >
              <h2 className="text-2xl font-extrabold tracking-tight">Pengaturan</h2>

              <div className="bg-surface p-10 rounded-[20px] border border-border space-y-12">
                <section className="space-y-6">
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-text-muted" />
                    <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">WhatsApp Group</h3>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Group ID</label>
                    <input 
                      type="text" 
                      value={settings?.group_id || ""} 
                      onChange={(e) => setSettings(s => s ? {...s, group_id: e.target.value} : null)}
                      placeholder="123456789@g.us"
                      className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none transition-all"
                    />
                    {settings?.last_detected_group && (
                      <div className="flex items-center gap-2 mt-2 p-2 bg-accent/5 rounded-lg border border-accent/10">
                        <span className="text-[10px] font-bold text-accent uppercase">ID Terdeteksi:</span>
                        <code className="text-[11px] font-mono break-all">{settings.last_detected_group}</code>
                        <button 
                          onClick={() => setSettings(s => s ? {...s, group_id: settings.last_detected_group} : null)}
                          className="ml-auto text-[10px] font-bold text-white bg-accent px-2 py-1 rounded hover:opacity-90 active:scale-95 transition-all"
                        >
                          GUNAKAN ID
                        </button>
                      </div>
                    )}
                    <p className="text-[11px] text-text-muted italic opacity-70">Tips: Kirim pesan ke grup tujuan, lalu ID akan muncul otomatis di atas.</p>
                  </div>
                </section>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                  <section className="space-y-6">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-text-muted" />
                      <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">Waktu Reminder</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Pagi</label>
                        <input 
                          type="time" 
                          value={settings?.morning_time || ""} 
                          onChange={(e) => setSettings(s => s ? {...s, morning_time: e.target.value} : null)}
                          className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Sore</label>
                        <input 
                          type="time" 
                          value={settings?.afternoon_time || ""} 
                          onChange={(e) => setSettings(s => s ? {...s, afternoon_time: e.target.value} : null)}
                          className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none"
                        />
                      </div>
                    </div>
                  </section>

                  <section className="space-y-6">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-text-muted" />
                      <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">Tes Kirim</h3>
                    </div>
                    <div className="flex gap-3">
                      <button onClick={() => testSend("morning")} className="flex-1 bg-bg border border-border rounded-xl p-3 text-xs font-bold hover:bg-surface transition-colors">TES PAGI</button>
                      <button onClick={() => testSend("afternoon")} className="flex-1 bg-bg border border-border rounded-xl p-3 text-xs font-bold hover:bg-surface transition-colors">TES SORE</button>
                    </div>
                  </section>
                </div>

                <section className="space-y-6 pt-6 border-t border-border">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-text-muted" />
                    <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">Kustomisasi Pesan</h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Pesan Pagi</label>
                      <textarea 
                        rows={4}
                        value={settings?.morning_msg || ""} 
                        onChange={(e) => setSettings(s => s ? {...s, morning_msg: e.target.value} : null)}
                        className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none resize-none"
                        placeholder="Masukkan pesan reminder pagi..."
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Pesan Sore</label>
                      <textarea 
                        rows={4}
                        value={settings?.afternoon_msg || ""} 
                        onChange={(e) => setSettings(s => s ? {...s, afternoon_msg: e.target.value} : null)}
                        className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none resize-none"
                        placeholder="Masukkan pesan reminder sore..."
                      />
                    </div>
                  </div>
                  <div className="pt-6 border-t border-border mt-6">
                    <div className="flex items-center gap-2 mb-4">
                      <Clock className="w-4 h-4 text-text-muted" />
                      <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest">Wilayah Waktu (Timezone)</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-text-muted uppercase tracking-widest">Pilih Timezone</label>
                        <select 
                          value={settings?.timezone || "Asia/Jakarta"}
                          onChange={(e) => setSettings(s => s ? {...s, timezone: e.target.value} : null)}
                          className="w-full bg-bg border border-border rounded-xl px-4 py-3 text-sm focus:ring-1 focus:ring-brand outline-none appearance-none cursor-pointer"
                        >
                          <option value="Asia/Jakarta">WIB (Asia/Jakarta) - GMT+7</option>
                          <option value="Asia/Makassar">WITA (Asia/Makassar) - GMT+8</option>
                          <option value="Asia/Jayapura">WIT (Asia/Jayapura) - GMT+9</option>
                          <option value="UTC">UTC (Universal Time) - GMT+0</option>
                        </select>
                      </div>
                      {serverTime && (
                        <div className="p-4 bg-bg rounded-xl border border-border space-y-2">
                          <div className="flex justify-between items-center text-[11px]">
                            <span className="text-text-muted font-bold uppercase tracking-wider">Waktu Realtime:</span>
                            <span className="font-mono text-brand">{serverTime.zoned_time.split(" ")[1]}</span>
                          </div>
                          <div className="flex justify-between items-center text-[10px]">
                            <span className="text-text-muted opacity-60 uppercase tracking-wider">Server (UTC):</span>
                            <span className="font-mono text-text-muted opacity-60">{serverTime.server_time}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-accent font-bold italic opacity-80 mt-2">
                    💡 Gunakan tag <code className="bg-accent/10 px-1 rounded">@semua</code> atau <code className="bg-accent/10 px-1 rounded">@everyone</code> di dalam pesan untuk melakukan mention ke seluruh anggota grup secara otomatis.
                  </p>
                </section>

                <div className="pt-6 border-t border-border flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <button 
                    onClick={saveSettings}
                    className="bg-text-main text-white rounded-xl px-8 py-3 text-sm font-bold shadow-lg shadow-text-main/10 hover:opacity-90 active:scale-95 transition-all"
                  >
                    Simpan Perubahan
                  </button>
                  
                  {settings?.last_holiday_sync && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-bg rounded-lg border border-border">
                      <CalendarIcon className="w-3.5 h-3.5 text-text-muted" />
                      <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest">
                        Libur Resmi ID: <span className="text-accent">{settings.last_holiday_sync}</span> (OK)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "logs" && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              key="logs"
              className="space-y-8"
            >
              <h2 className="text-2xl font-extrabold tracking-tight">Log Aktivitas</h2>

              <div className="bg-surface rounded-[20px] border border-border overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="bg-bg border-b border-border">
                      <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">Waktu</th>
                      <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">Sesi</th>
                      <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">Status</th>
                      <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">Detail Pesan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-bg transition-colors">
                        <td className="px-6 py-4 font-semibold text-text-muted">
                           {format(parseISO(log.datetime), "PPP, HH:mm")}
                        </td>
                        <td className="px-6 py-4">
                           <span className={cn(
                             "text-[10px] font-extrabold px-2 py-1 rounded uppercase tracking-wider",
                             log.type === "morning" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-900"
                           )}>
                             {log.type}
                           </span>
                        </td>
                        <td className="px-6 py-4">
                           <div className="flex items-center gap-2 font-bold">
                             <div className={cn("w-2 h-2 rounded-full", log.status === "success" ? "bg-accent" : "bg-danger")} />
                             {log.status}
                           </div>
                        </td>
                        <td className="px-6 py-4 text-text-muted text-xs italic">
                           {log.message}
                        </td>
                      </tr>
                    ))}
                    {logs.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-6 py-20 text-center text-text-muted italic opacity-60">Belum ada riwayat aktivitas.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.9 }}
              className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
            >
              <div className={cn(
                "px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-md border",
                toast.type === "success" 
                  ? "bg-accent/90 text-white border-white/20" 
                  : "bg-danger/90 text-white border-white/20"
              )}>
                <CheckCircle2 className="w-5 h-5" />
                <span className="text-sm font-bold tracking-tight">{toast.message}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Confirmation Modal */}
        <AnimatePresence>
          {confirmModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-surface w-full max-w-sm rounded-[32px] p-8 shadow-2xl border border-border"
              >
                <div className="flex flex-col items-center text-center gap-6">
                  <div className={cn(
                    "p-4 rounded-full bg-opacity-10",
                    confirmModal.isWorkday ? "bg-danger text-danger" : "bg-success text-success"
                  )}>
                    {confirmModal.isWorkday ? <XCircle size={32} /> : <CheckCircle2 size={32} />}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-2">
                      Ubah ke {confirmModal.isWorkday ? 'HARI LIBUR' : 'HARI KERJA'}?
                    </h3>
                    <p className="text-text-muted text-sm px-4">
                      Apakah Anda yakin ingin mengubah status tanggal <span className="font-bold text-brand">{confirmModal.date}</span>?
                    </p>
                  </div>
                  <div className="flex w-full gap-3">
                    <button 
                      onClick={() => setConfirmModal(null)}
                      className="flex-1 p-4 rounded-2xl bg-bg font-bold hover:bg-border transition-colors text-text-main"
                    >
                      Batal
                    </button>
                    <button 
                      onClick={() => toggleWorkday(confirmModal.date, confirmModal.isWorkday)}
                      className={cn(
                        "flex-1 p-4 rounded-2xl text-white font-bold transition-all",
                        confirmModal.isWorkday ? "bg-danger hover:bg-danger/80" : "bg-success hover:bg-success/80"
                      )}
                    >
                      Ubah Status
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function NavListItem({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <li 
      onClick={onClick}
      className={cn(
        "px-4 py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all",
        active ? "bg-bg text-text-main shadow-sm" : "text-text-muted hover:text-text-main hover:translate-x-1"
      )}
    >
      {label}
    </li>
  );
}

function StatCard({ label, value, indicatorColor, unit, caption, isDark }: { label: string; value: string; indicatorColor?: string; unit?: string; caption?: string; isDark?: boolean }) {
  return (
    <div className={cn(
      "p-6 rounded-[20px] border",
      isDark ? "bg-text-main text-white border-transparent" : "bg-surface border-border shadow-sm shadow-text-main/5 text-text-main"
    )}>
      <p className={cn("text-[11px] font-extrabold uppercase tracking-widest mb-3", isDark ? "text-white/60" : "text-text-muted")}>{label}</p>
      <div className="text-[26px] font-extrabold tracking-tight flex items-baseline gap-2">
        {indicatorColor && (
          <span className={cn("w-2.5 h-2.5 rounded-full mb-1", indicatorColor)} />
        )}
        {value}
        {unit && <span className="text-sm font-medium opacity-50 ml-1">{unit}</span>}
      </div>
      {caption && <p className={cn("text-xs mt-2 font-medium", isDark ? "text-white/60" : "text-text-muted")}>{caption}</p>}
    </div>
  );
}

