@echo off
REM Serve the Site Monitor dashboard off the Docker archive on
REM http://localhost:8899 — no Supabase, no internet needed.
REM
REM Launched at logon by a hidden VBS in the Startup folder. Remove with:
REM   del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WebMonitorDashboard.vbs"
REM
REM This starts Docker Desktop itself rather than waiting for it. The earlier
REM version only waited, and the log showed it giving up four times in a row:
REM Docker Desktop does not launch at logon on this machine, so the wait could
REM never succeed and the dashboard was never there when it was wanted.
cd /d "%~dp0.."
set "LOG=%TEMP%\wm_local_dashboard.log"
echo [%date% %time%] starting >> "%LOG%"

REM Already serving? Nothing to do — a second copy would only fail on the port.
curl -s -o nul -m 5 http://localhost:8899/api/config && (
  echo [%date% %time%] already running on :8899 >> "%LOG%"
  exit /b 0
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] docker daemon down, launching Docker Desktop >> "%LOG%"
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
)

REM Up to 20 minutes. Docker Desktop from cold can take several minutes before
REM the engine accepts connections, and the containers then need their own
REM moment; a short timeout here is what produced the "gave up" lines.
set /a tries=0
:wait
docker exec wm-archive-db pg_isready -U monitor -d monitor >nul 2>&1
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% geq 120 (
  echo [%date% %time%] gave up after 20 minutes waiting for the archive container >> "%LOG%"
  exit /b 1
)
timeout /t 10 /nobreak >nul
goto wait

:ready
echo [%date% %time%] archive ready, serving on http://localhost:8899 >> "%LOG%"
node scripts\local_dashboard.mjs >> "%LOG%" 2>&1
