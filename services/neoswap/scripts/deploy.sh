#!/bin/bash

# NeoSwap v2 - Quick Start Deployment Script

echo "========================================"
echo "NeoSwap v2 - Microservices Deployment"
echo "========================================"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "✅ Docker and Docker Compose are available"

# Build all services
echo ""
echo "🔨 Building Docker images..."
docker-compose build --parallel

# Start all services in detached mode
echo ""
echo "🚀 Starting all services..."
docker-compose up -d

# Wait for services to become healthy
echo ""
echo "⏳ Waiting for services to become healthy..."
sleep 10

# Health check
echo ""
echo "🏥 Checking service health..."
docker-compose ps

# Show logs for the first time
echo ""
echo "📋 Recent logs (last 50 lines):"
docker-compose logs --tail=50

echo ""
echo "========================================"
echo "✅ NeoSwap v2 deployment complete!"
echo "========================================"
echo ""
echo "Services:"
echo "  - API Gateway:          http://localhost:3001"
echo "  - Routing Engine:       http://localhost:3002"
echo "  - Order Matcher:        http://localhost:3003"
echo "  - Oracle Aggregator:    ws://localhost:8080"
echo "  - Price Feed Server:    ws://localhost:8082"
echo "  - Analytics API:        http://localhost:3005"
echo "  - Prometheus:           http://localhost:9090"
echo "  - Grafana:              http://localhost:3006"
echo ""
echo "To monitor logs:"
echo "  docker-compose logs -f"
echo ""
echo "To stop services:"
echo "  docker-compose down"
echo ""
echo "Documentation: https://github.com/your-org/neoswap-v2"
