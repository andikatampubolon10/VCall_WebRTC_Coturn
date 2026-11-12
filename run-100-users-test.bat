@echo off
title Benchmark Dynamic Concurrent WebRTC Users
chcp 65001 >nul
echo ========================================================
echo   UJI BEBAN DINAMIS PENGGUNA BERBARENGAN WEBRTC & COTURN
echo ========================================================
echo.
echo Pastikan Server/Gateway sudah aktif di Port 3000!
echo.
set /p VUS_INPUT="Masukkan jumlah Virtual Users (VUs) [Contoh: 10, 100, 1000, 100000] (Enter untuk default 100): "
if "%VUS_INPUT%"=="" set VUS_INPUT=100
echo.
echo [INFO] Menjalankan pengujian untuk %VUS_INPUT% Virtual Users...
echo.
node test-concurrent-100.js %VUS_INPUT%
pause

