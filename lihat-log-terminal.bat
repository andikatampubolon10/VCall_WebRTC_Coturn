@echo off
title [LIVE] WEBRTC GATEWAY & ICE MONITOR
chcp 65001 >nul
color 0A

echo ======================================================================
echo 📡 REAL-TIME WEBRTC SIGNALING & ICE CANDIDATE TERMINAL MONITOR
echo ======================================================================
echo Gateway URL : ws://localhost:3000
echo Log File    : %~dp0gateway\gateway.log
echo.
echo Status      : Memantau log secara LIVE (Streaming)...
echo Petunjuk    : Lakukan panggilan video di browser / HP untuk melihat
echo               log STUN dan Metered TURN Cloud muncul di bawah ini!
echo ======================================================================
echo.

powershell -NoExit -Command "Get-Content -Path '%~dp0gateway\gateway.log' -Wait -Tail 25"

