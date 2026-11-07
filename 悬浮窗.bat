@echo off
chcp 65001 >nul
title PokeMMO Float Window
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\float.ps1"