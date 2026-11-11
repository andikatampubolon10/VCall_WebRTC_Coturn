@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================================================
echo 📱 MEMBUKA TUNNEL NGROK UNTUK APLIKASI B (HP / SMARTPHONE)
echo ======================================================================
echo.
echo Tunnel ini akan menghubungkan HP Anda ke Aplikasi B (Port 3002) via HTTPS.
echo Browser HP akan langsung mengizinkan Kamera & Mikrofon tanpa error.
echo.
echo Menjalankan Ngrok pada Port 3002...
echo.
ngrok http 3002
pause
