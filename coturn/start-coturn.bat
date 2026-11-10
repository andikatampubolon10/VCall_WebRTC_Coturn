@echo off
echo ===================================================
echo Menjalankan Coturn Server via Docker Compose...
echo ===================================================

docker compose up -d

echo.
echo Cek status container:
docker ps --filter "name=coturn-simulasi"

echo.
echo Untuk melihat live log Coturn, jalankan:
echo   docker logs -f coturn-simulasi
echo ===================================================
pause

