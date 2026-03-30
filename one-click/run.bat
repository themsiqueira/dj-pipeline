@echo off
cd /d %~dp0\..
set /p PLAYLIST_URL="Paste playlist URL: "
npm run run -- "%PLAYLIST_URL%"
echo.
echo Done. Files in .\output\audio and XML in .\output\rekordbox
pause

