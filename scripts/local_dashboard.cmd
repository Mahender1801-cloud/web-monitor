@echo off
REM Serve the Site Monitor dashboard off the Docker archive on
REM http://localhost:8899 — no Supabase, no internet needed.
REM
REM Registered via a hidden launcher in the Startup folder so it comes back
REM after every logon. Remove it by deleting:
REM   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WebMonitorDashboard.vbs
REM
REM Waits for Docker, because at logon this usually starts before the Docker
REM daemon is ready and PostgREST would otherwise refuse every query.
cd /d "%~dp0.."

set /a tries=0
:waitdocker
docker exec wm-archive-db pg_isready -U monitor -d monitor >nul 2>&1
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% geq 60 (
  echo [%date% %time%] gave up waiting for the archive container >> "%TEMP%\wm_local_dashboard.log"
  exit /b 1
)
timeout /t 10 /nobreak >nul
goto waitdocker

:ready
echo [%date% %time%] archive ready, starting dashboard on :8899 >> "%TEMP%\wm_local_dashboard.log"
node scripts\local_dashboard.mjs >> "%TEMP%\wm_local_dashboard.log" 2>&1
