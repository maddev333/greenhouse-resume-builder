#!/bin/bash
# Quick start script for Greenhouse Resume Builder
# This script helps set up and run the development environment

echo "========================================"
echo "Greenhouse Resume Builder - Quick Start"
echo "========================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found. Please install Node.js v20+ from https://nodejs.org/"
    exit 1
fi
echo "Node version: $(node --version)"

# Check if .env exists
if [ ! -f .env ]; then
    echo "[WARN] .env file not found"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo ""
    echo "IMPORTANT: Edit .env and configure your PostgreSQL connection!"
    echo ""
    read -p "Press enter to continue..."
fi

echo ""
echo "Step 1: Installing dependencies..."
npm ci
if [ $? -ne 0 ]; then
    echo "[ERROR] npm ci failed"
    exit 1
fi

echo ""
echo "Step 2: Building shared packages..."
npm run build -w @greenhouse-resume-builder/shared
if [ $? -ne 0 ]; then
    echo "[ERROR] Build failed"
    exit 1
fi

echo ""
echo "Step 3: Building API..."
npm run build -w @greenhouse-resume-builder/api
if [ $? -ne 0 ]; then
    echo "[ERROR] API build failed"
    exit 1
fi

echo ""
echo "========================================"
echo "Setup Complete!"
echo "========================================"
echo ""
echo "To run the application:"
echo "  1. Start API:   cd api && npm run dev"
echo "  2. Start UI:    cd ui && npm run dev"
echo "  3. (Optional) Functions: cd functions && npm run start:dev"
echo ""
echo "Or use VS Code debugger (F5) for easier development"
echo ""
echo "See DEVELOPMENT.md for detailed instructions"
echo "========================================"
