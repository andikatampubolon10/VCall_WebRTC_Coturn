@echo off
title WebRTC & CoTURN Benchmarking Dashboard Launcher
chcp 65001 >nul
echo ======================================================================
echo   MEMBUKA WEBRTC & COTURN BENCHMARKING DASHBOARD
echo ======================================================================
echo.
echo Membuka dashboard pengujian beban di browser default Anda...
echo URL: http://localhost:3000/benchmark.html
echo.
start http://localhost:3000/benchmark.html
echo [INFO] Jika halaman belum tampil, pastikan Gateway/Server sudah aktif
echo dengan menjalankan 'start-ecosystem.bat' terlebih dahulu.
echo ======================================================================
timeout /t 3 >nul
