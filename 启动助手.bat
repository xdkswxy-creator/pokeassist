@echo off
chcp 65001 >nul
title PokeMMO Battle Assistant
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined PY if exist "C:\Users\ZhuanZ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=C:\Users\ZhuanZ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined PY goto nopy
"%PY%" server.py %*
echo.
echo Server stopped. Press any key to close this window.
pause >nul
exit /b 0
:nopy
echo.
echo Python was not found, so the assistant cannot start.
echo Send a screenshot of this window to whoever made this tool for you.
echo.
pause
exit /b 1
