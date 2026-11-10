@echo off
title Simulasi WebRTC + Coturn Server Launcher
echo ========================================================
echo   SIMULASI WEBRTC VOICE/VIDEO CALL DENGAN COTURN
echo ========================================================
echo.

echo [1/3] Menjalankan Docker Coturn Server (STUN/TURN)...
docker compose up -d

if %errorlevel% neq 0 (
    echo.
    echo [PERINGATAN] Gagal menjalankan Docker!
    echo Pastikan aplikasi Docker Desktop sudah dalam keadaan 'Running'.
    echo Anda tetap dapat melanjutkan menjalankan Signaling Server untuk pengujian.
    echo.
) else (
    echo [OK] Coturn Server aktif di port 3478 (UDP/TCP)!
)

echo.
echo [2/3] Membuka jendela log real-time Coturn...
start "Coturn Live Logs" cmd /k "docker logs -f coturn-simulasi"

echo.
echo [3/3] Menjalankan WebRTC Signaling & Web Server...
cd server
start "WebRTC Signaling Server (Port 3000)" cmd /k "npm start"

echo.
echo ========================================================
echo   SEMUA SERVICE TELAH DIJALANKAN!
echo ========================================================
echo.
echo Silakan buka browser Anda di:
echo    http://localhost:3000
echo.
echo Buka dua tab berbeda:
echo    Tab 1: Login sebagai 'User A'
echo    Tab 2: Login sebagai 'User B'
echo.
echo Tekan sembarang tombol untuk membuka browser otomatis...
pause >nul
start http://localhost:3000

