@echo off
REM Start the Site Monitor dashboard off the Docker archive (no Supabase).
REM Double-click this, then open http://localhost:8899 and click "90 days".
cd /d "%~dp0"
echo Starting the Docker archive...
docker compose -f docker/docker-compose.yml up -d
echo.
echo Dashboard will be at http://localhost:8899  (click "90 days" for all data)
echo Press Ctrl+C to stop.
echo.
node scripts/local_dashboard.mjs
