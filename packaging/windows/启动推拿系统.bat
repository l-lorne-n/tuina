@echo off
chcp 65001 >nul
cd /d "%~dp0TuinaPatientManager"
echo 正在启动推拿患者管理系统，请稍等...
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8781/patient-search.html'"
TuinaPatientManager.exe --host 127.0.0.1 --port 8781
pause
