@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================================
echo 🚀 MEMULAI EKOSISTEM WEBRTC DUA APLIKASI MANDIRI (APP A & APP B)
echo ======================================================================
echo.

:: 0. Memastikan Docker Coturn Aktif
echo [0/3] Menjalankan Coturn Server (STUN/TURN di Docker)...
docker compose up -d
echo.

:: 1. Memulai Gateway (Port 3000)
echo [1/3] Menjalankan Shared WebRTC Gateway pada Port 3000...
start "Gateway-Port-3000" cmd /k "cd /d \"%~dp0gateway\" && node index.js"

:: 2. Memulai Aplikasi A (Port 3001)
echo [2/3] Menjalankan Aplikasi A (Portal RS / Dokter) pada Port 3001...
start "App-A-Doctor-Portal-3001" cmd /k "cd /d \"%~dp0app-a\" && node server.js"

:: 3. Memulai Aplikasi B (Port 3002)
echo [3/3] Menjalankan Aplikasi B (Mobile Patient App) pada Port 3002...
start "App-B-Patient-App-3002" cmd /k "cd /d \"%~dp0app-b\" && node server.js"

echo.
echo Menunggu inisialisasi server (3 detik)...
timeout /t 3 /nobreak >nul

echo.
echo ======================================================================
echo 🌐 MEMBUKA BROWSER...
echo    Aplikasi A : http://localhost:3001 (Neon US-East)
echo    Aplikasi B : http://localhost:3002 (Neon Singapore)
echo    Benchmark  : http://localhost:3000 (Dashboard Uji Beban 100 VUs)
echo ======================================================================
start http://localhost:3001
start http://localhost:3002
echo [TIPS] Buka http://localhost:3000 untuk Uji Beban 100 Users

echo.
echo ======================================================================
echo [INFO] Ketiga server (Gateway, App A, App B) SEDANG BERJALAN.
echo JANGAN TUTUP jendela terminal hitam yang baru saja terbuka.
echo Anda dapat menutup jendela launcher ini sekarang.
echo ======================================================================
pause
