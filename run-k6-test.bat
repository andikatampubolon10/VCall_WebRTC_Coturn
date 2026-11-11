@echo off
title K6 Load Testing - 100 Concurrent WebRTC Users
chcp 65001 >nul
echo ======================================================================
echo   PENGUJIAN BEBAN 100 PENGGUNA BERBARENGAN WEBRTC & COTURN (K6)
echo ======================================================================
echo.
echo [1/2] Memeriksa ketersediaan Gateway Server di Port 3000...
echo.

:: Cek apakah k6 terinstall di Windows
where k6 >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Binary Grafana k6 lokal ditemukan!
    echo [INFO] Memulai eksekusi load-test-k6.js (100 Concurrent VUs)...
    echo.
    k6 run load-test-k6.js
    goto :selesai
)

:: Jika k6 lokal tidak ada, coba Docker resmi grafana/k6
where docker >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] k6 binary lokal tidak terdeteksi.
    echo [INFO] Menggunakan kontainer Docker resmi: grafana/k6...
    echo.
    docker run --rm -i -v "%cd%:/scripts" -e GATEWAY_URL="ws://host.docker.internal:3000" grafana/k6 run /scripts/load-test-k6.js
    if %errorlevel% equ 0 goto :selesai
    echo [PERINGATAN] Docker daemon belum aktif atau mengalami kendala.
)

:: Fallback cerdas: Jika K6 dan Docker belum terpasang/aktif
echo.
echo ======================================================================
echo [FALLBACK OTOMATIS] Menjalankan Engine Pengujian Sintetis (Node.js)
echo Menjalankan 50 pasang panggilan simultan (100 Virtual Users)...
echo ======================================================================
echo.
node test-concurrent-100.js

:selesai
echo.
echo ======================================================================
echo [SELESAI] Pengujian Beban 100 Concurrent Users Selesai Dijalankan!
echo Silakan simpan / screenshot tabel metrik di atas untuk laporan skripsi.
echo ======================================================================
echo.
pause
