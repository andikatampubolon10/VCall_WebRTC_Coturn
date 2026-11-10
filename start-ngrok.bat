@echo off
title Ngrok WebRTC Tunnel (Port 3000)
echo ========================================================
echo   MEMBUKA TEROWONGAN NGROK UNTUK WEBRTC SIMULATOR
echo ========================================================
echo.
echo Pastikan Signaling Server sudah berjalan (npm start di folder server).
echo.
echo Menjalankan Ngrok pada port 3000...
echo.

ngrok http 3000

pause

