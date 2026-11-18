@echo off
title Reverie
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Reverie needs Node.js 20 or newer. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node app\main.mjs %*
if errorlevel 1 pause
