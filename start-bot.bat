@echo off
chcp 65001 >nul
cd /d "%~dp0bot"
echo Запускаю ТЕЛО бота (Mineflayer + мост)...
echo Если нужно указать порт мира: start-bot.bat --port 54321
node index.js %*
pause
