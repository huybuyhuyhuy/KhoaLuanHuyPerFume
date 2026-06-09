@echo off
chcp 65001 >nul
title Huy Perfume - Start Local App

echo ============================================
echo   HUY PERFUME - START LOCAL APPLICATION
echo ============================================
echo.
echo Restarting API and both frontends without resetting database data...

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-huyperfume.ps1" -Restart -OpenBrowser

if errorlevel 1 (
    echo.
    echo [ERROR] Application could not be started.
    echo Check "%~dp0.runtime\logs" for details.
    pause
    exit /b 1
)

echo.
echo Ready:
echo   User frontend : http://localhost:5177/home
echo   Admin frontend: http://localhost:5178/
echo   Backend API   : http://localhost:4000/api/health
echo.
echo Runtime logs are stored in .runtime\logs.
pause
--NGUYEN VAN A 9704 0000 0000 0018  03/07   OTP Thành công                         
--4111111111111111    NGUYEN VAN A    01/28   123                                                
      --phai co kl cua chuong , 