@echo off
rem ============================================
rem  Steam 游戏视频批量下载 - 启动脚本
rem  启动后浏览器打开 http://localhost:8898
rem  保持本窗口开启；Ctrl+C 或关窗即停止服务
rem ============================================
cd /d "%~dp0"
echo ============================================
echo   Steam Video Downloader - Launcher
echo   Keep this window OPEN while using the tool.
echo   Open in browser:  http://localhost:8898
echo   To stop: close this window or press Ctrl+C
echo ============================================
echo.
node --use-system-ca steam-video-downloader.mjs
echo.
echo Service stopped.
pause
