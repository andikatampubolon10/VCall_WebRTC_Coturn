@echo off
title Tunnel untuk Aplikasi B (Port 3002)
chcp 65001 >nul
echo ========================================================
echo   MEMBUKA TUNNEL HTTPS UNTUK APLIKASI B (PORT 3002)
echo ========================================================
echo.
echo Pastikan start-ecosystem.bat sudah berjalan terlebih dahulu!
echo.
echo [1] Mencoba menjalankan Ngrok pada Port 3002...
ngrok http 3002
if %errorlevel% neq 0 (
    echo.
    echo [INFO] Perintah 'ngrok' belum terpasang atau belum di-PATH.
    echo [2] Menggunakan alternatif otomatis: Localtunnel (Gratis tanpa instalasi)...
    echo.
    npx localtunnel --port 3002
)
pause

