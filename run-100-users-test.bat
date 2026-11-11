@echo off
title Benchmark 100 Concurrent WebRTC Users
chcp 65001 >nul
echo ========================================================
echo   UJI BEBAN 100 PENGGUNA BERBARENGAN (CONCURRENT TEST)
echo ========================================================
echo.
echo Pastikan Server/Gateway sudah aktif di Port 3000!
echo.
node test-concurrent-100.js
pause

