@echo off
chcp 65001 > nul
title 藏书阁 · 豆瓣代理服务
cd /d "%~dp0"
echo 正在启动豆瓣本地代理（127.0.0.1:8765）...
echo 保持本窗口开启即可；关闭窗口或 Ctrl+C 即停止服务。
echo.
"C:\Users\Mickey\AppData\Local\Loomy\python-runtime\3.13.13-09efd5c6\python.exe" _douban_server.py
pause
