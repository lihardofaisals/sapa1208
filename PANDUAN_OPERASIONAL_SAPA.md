# 📘 Panduan Operasional & Pemeliharaan Bot SAPA
**Sistem Alarm Presensi BPS Kabupaten Asahan (SAPA)**

Panduan ini disusun untuk memastikan bot SAPA tetap beroperasi 24/7 di PC server lokal.

---

## 1. Perintah Harian (Quick Check)
Gunakan perintah ini di CMD atau PowerShell untuk memantau status bot:

*   **Cek Status Bot:**
    ```bash
    pm2 status
    ```
    *(Pastikan status 'SAPA-BPS' berwarna hijau/online)*

*   **Melihat Log Pengiriman (Real-time):**
    ```bash
    pm2 logs SAPA-BPS --lines 50
    ```
    *(Gunakan ini untuk melihat apakah pesan terkirim atau ada error WhatsApp)*

---

## 2. Pemeliharaan Rutin
Lakukan langkah ini jika ada perubahan kode atau bot terasa melambat:

1.  **Restart Bot (Jurus Ampuh):**
    ```bash
    pm2 restart SAPA-BPS
    ```
2.  **Build Ulang Tampilan (Jika edit file .tsx):**
    ```bash
    npm run build
    ```
3.  **Simpan Konfigurasi (Wajib setelah setting PM2):**
    ```bash
    pm2 save
    ```

---

## 3. Fitur Penjadwalan Otomatis
Bot telah dikonfigurasi dengan logika cerdas:
*   **Senin - Kamis:** Reminder Sore dikirim pukul **16:00 WIB**.
*   **Jumat:** Reminder Sore dikirim pukul **16:30 WIB** (Otomatis).
*   **Sabtu - Minggu:** Libur (Otomatis).
*   **Hari Libur Nasional:** Bot akan otomatis tidak mengirim pesan jika tanggal tersebut merah di kalender (Sinkron Google Calendar).

---

## 4. Penanganan Kendala (Troubleshooting)

| Masalah | Solusi |
|---------|--------|
| **Dashboard tidak bisa dibuka** | Cek apakah terminal CMD tertutup. Jalankan `pm2 start server.ts --interpreter node --node-args="--import tsx" --name "SAPA-BPS"` |
| **WhatsApp Terputus / Logout** | Pergi ke `http://localhost:3000`, scan ulang QR Code yang muncul di dashboard. |
| **Pesan Tidak Terkirim** | 1. Cek kuota internet PC. 2. Cek Log dengan `pm2 logs`. 3. Pastikan Group ID sudah benar di Pengaturan. |
| **PC Restart/Mati Lampu** | Jika sudah menjalankan `pm2 save`, bot akan menyala otomatis saat PC masuk ke desktop. |

---

## 5. Kontak & Dokumentasi
*   **URL Lokal:** `http://localhost:3000`
*   **API AI Service:** Google Gemini (untuk Quote Motivasi)
*   **Engine:** Node.js + PM2

---
*Dikembangkan untuk: BPS Kabupaten Asahan - 2024*
