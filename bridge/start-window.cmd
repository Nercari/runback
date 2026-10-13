@echo off
cd /d "%~dp0"
start "Runback bridge" cmd /k node "%~dp0supervisor.js" %*
