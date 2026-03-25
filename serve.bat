@echo off
cd /d "%~dp0"
echo Starting GCG META local server...
echo Open http://localhost:8080
echo Press Ctrl+C to stop
echo.
python server.py
