@echo off
chcp 65001 >nul
echo ======================================================================
echo 🛑 MENGHENTIKAN EKOSISTEM WEBRTC (GATEWAY, APP A, APP B, COTURN)
echo ======================================================================
echo.

echo Menghentikan proses Node.js pada port 3000, 3001, 3002...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 "') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3002 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Menghentikan container Coturn jika ada...
docker compose down >nul 2>&1

echo.
echo [SELESAI] Semua layanan telah dihentikan dengan aman.
pause

