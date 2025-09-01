#!/bin/bash

# WebRTC Signaling Server Deployment Script

echo "🚀 WebRTC Signaling Server Deployment Script"
echo "============================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed successfully"

# Check if Docker is available
if command -v docker &> /dev/null; then
    echo "🐳 Docker is available"
    
    # Build Docker image
    echo "🔨 Building Docker image..."
    docker build -t webrtc-signaling .
    
    if [ $? -eq 0 ]; then
        echo "✅ Docker image built successfully"
        echo ""
        echo "To run with Docker:"
        echo "  docker run -p 8080:8080 webrtc-signaling"
        echo ""
        echo "To run with custom environment variables:"
        echo "  docker run -p 8080:8080 -e ALLOWED_ORIGIN=https://yourdomain.com webrtc-signaling"
    else
        echo "❌ Failed to build Docker image"
    fi
else
    echo "ℹ️  Docker not available, skipping Docker build"
fi

echo ""
echo "🎯 Local Development:"
echo "  npm run dev          # Start development server with auto-reload"
echo "  npm start            # Start production server"
echo ""
echo "🌐 Server will be available at:"
echo "  - HTTP: http://localhost:8080"
echo "  - WebSocket: ws://localhost:8080/ws"
echo "  - Health Check: http://localhost:8080/healthz"
echo ""
echo "🧪 Test Client:"
echo "  Open test-client.html in your browser to test the server"
echo ""
echo "🚀 Render Deployment:"
echo "  1. Push this code to a Git repository"
echo "  2. Connect the repository to Render"
echo "  3. Create a new Web Service"
echo "  4. Select Docker environment"
echo "  5. Deploy!"
echo ""
echo "📚 For more information, see README.md"
echo ""
echo "✨ Setup complete! Happy coding!"
