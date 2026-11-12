@echo off
chcp 65001 >nul
echo ======================================================================
echo  PENGUJIAN KAPASITAS BERTINGKAT COTURN & WEBRTC (100 - 250 - 500 USERS)
echo ======================================================================
echo.
set /p VPS_IP="Masukkan IP Server VPS [Default: 34.50.75.236]: "
if "%VPS_IP%"=="" set VPS_IP=34.50.75.236

echo.
echo Pilih Tingkatan Beban Pengujian:
echo 1. Uji Cepat 100 Users
echo 2. Uji 250 Users
echo 3. Uji 500 Users
echo 4. Uji Bertingkat Lengkap (100, 250, 500 Users Otomatis)
set /p PILIHAN="Pilihan Anda (1-4) [Default: 4]: "

if "%PILIHAN%"=="1" set TIERS=100
if "%PILIHAN%"=="2" set TIERS=250
if "%PILIHAN%"=="3" set TIERS=500
if "%PILIHAN%"=="4" set TIERS=100,250,500
if "%TIERS%"=="" set TIERS=100,250,500

echo.
echo Menjalankan uji kapasitas bertingkat ke ws://%VPS_IP%:3000 ...
node benchmark-capacity.js %TIERS% ws://%VPS_IP%:3000 %VPS_IP%
pause
