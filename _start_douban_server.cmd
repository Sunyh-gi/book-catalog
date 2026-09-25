@echo off
title BookLib - Douban Proxy (127.0.0.1:8765)
cd /d "%~dp0"
echo Starting local Douban proxy at 127.0.0.1:8765 ...
echo Keep this window open. Close it or press Ctrl+C to stop.
echo.

REM ASCII only on purpose: this file is published, and non-ASCII text breaks
REM cmd.exe parsing whenever the console codepage is not UTF-8 (chcp can fail
REM when there is no real console, e.g. launched from a script or CI).
REM Interpreter lookup order: managed runtime -> py launcher -> python on PATH.
set "PYEXE="
for /d %%D in ("%LOCALAPPDATA%\Loomy\python-runtime\*") do if not defined PYEXE if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
if defined PYEXE goto run
for /f "delims=" %%P in ('where py 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if defined PYEXE goto run
for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if defined PYEXE goto run

echo [ERROR] Python 3 not found. Install Python and add it to PATH,
echo         or set PYEXE in this script to the full path of python.exe.
pause
exit /b 1

:run
echo Using interpreter: %PYEXE%
"%PYEXE%" _douban_server.py
pause