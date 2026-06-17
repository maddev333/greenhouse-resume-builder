@echo off
REM Quick start script for Greenhouse Resume Builder
REM This script helps set up and run the development environment

echo ========================================
echo Greenhouse Resume Builder - Quick Start
echo ========================================
echo.

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js v20+ from https://nodejs.org/
    exit /b 1
)
node --version

REM Check if .env exists
if not exist .env (
    echo [WARN] .env file not found
    echo Creating .env from .env.example...
    copy .env.example .env
    echo.
    echo IMPORTANT: Edit .env and configure your PostgreSQL connection!
    echo.
    pause
)

echo.
echo Step 1: Installing dependencies...
call npm ci
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm ci failed
    exit /b 1
)

echo.
echo Step 2: Building shared packages...
call npm run build -w @greenhouse-resume-builder/shared
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed
    exit /b 1
)

echo.
echo Step 3: Building API...
call npm run build -w @greenhouse-resume-builder/api
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] API build failed
    exit /b 1
)

echo.
echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo To run the application:
echo   1. Start API:   cd api ^&^& npm run dev
echo   2. Start UI:    cd ui ^&^& npm run dev
echo   3. (Optional) Functions: cd functions ^&^& npm run start:dev
echo.
echo Or use VS Code debugger (F5) for easier development
echo.
echo See DEVELOPMENT.md for detailed instructions
echo ========================================
pause
