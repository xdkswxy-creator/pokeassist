@echo off
chcp 65001 >nul
title PokeMMO Battle Assistant - Share Online
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined PY if exist "C:\Users\ZhuanZ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=C:\Users\ZhuanZ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined PY goto nopy
"%PY%" share.py
echo.
pause >nul
exit /b
:nopy
echo Python was not found. Cannot start the assistant.
echo Ask the person who built this tool for help.
pause >nul
