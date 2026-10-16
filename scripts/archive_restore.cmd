@echo off
REM Pull the GitHub Release cold store into the Docker archive.
REM Registered with Task Scheduler as WebMonitorArchiveRestore so it runs
REM whenever this machine is on, and catches up after it has been off.
REM Remove with:  schtasks /delete /tn WebMonitorArchiveRestore /f
cd /d "%~dp0.."
node scripts\archive_restore.mjs >> "%TEMP%\wm_archive_restore.log" 2>&1
