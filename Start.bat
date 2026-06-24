@echo off
echo CodeCade Portal
echo.
if not exist node_modules (
  echo Installing dependencies...
  npm install
  echo.
)
node launcher.js
