@echo off
chcp 65001 >nul
cd /d "%~dp0brain"
echo Запускаю МОЗГ бота (Python)...
python brain.py
pause
