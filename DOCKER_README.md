# Docker Deployment Guide

This guide covers how to containerize and deploy the Bundler Orchestrator API using Docker.

## 🐳 Docker Files Overview

- `Dockerfile` - Production-optimized Docker image
- `.dockerignore` - Files to exclude from Docker build context
- `docker-compose.yml` - Local development with Docker
- `render.yaml` - Render.com deployment configuration
- `docker.env.example` - Environment variables template for Docker

## 🚀 Quick Start

### Local Development with Docker

1. **Copy environment file:**
   ```bash
   cp docker.env.example .env
   ```

2. **Edit `.env` with your actual values:**
   - Supabase URL and API key
   - External API endpoints
   - Frontend URL

3. **Build and run with Docker Compose:**
   ```bash
   npm run docker:dev
   ```

4. **Access the API:**
   - API: http://localhost:3000
   - Health check: http://localhost:3000/health

### Manual Docker Commands

1. **Build the image:**
   ```bash
   npm run docker:build
   # or
   docker build -t bundler-orchestrator .
   ```

2. **Run the container:**
   ```bash
   npm run docker:run
   # or
   docker run -p 3000:3000 --env-file .env bundler-orchestrator
   ```

## 🌐 Deploying to Render

### Option 1: Using render.yaml (Recommended)

1. **Push your code to GitHub/GitLab**

2. **Connect to Render:**
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New" → "Blueprint"
   - Connect your repository
   - Render will automatically detect the `render.yaml` file

3. **Set Environment Variables:**
   In the Render dashboard, set these environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `EXTERNAL_API_BASE_URL`
   - `FRONTEND_URL`
   - `ALLOWED_ORIGINS`

### Option 2: Manual Web Service

1. **Create a new Web Service in Render**

2. **Configure the service:**
   - **Build Command:** `docker build -t bundler-orchestrator .`
   - **Start Command:** `docker run -p $PORT:3000 bundler-orchestrator`
   - **Health Check Path:** `/health`

3. **Set Environment Variables** (same as above)

## 🔧 Docker Image Features

- **Base Image:** Node.js 18 Alpine (lightweight)
- **Security:** Non-root user execution
- **Health Checks:** Built-in health monitoring
- **Optimization:** Multi-stage build for smaller image size
- **Logging:** Persistent log directory
- **Production Ready:** Optimized for production deployment

## 📊 Monitoring

The Docker image includes:

- **Health Check Endpoint:** `/health`
- **Graceful Shutdown:** Handles SIGTERM and SIGINT
- **Structured Logging:** Winston logger with different levels
- **Process Monitoring:** Built-in Docker health checks

## 🛠️ Troubleshooting

### Common Issues

1. **Port Already in Use:**
   ```bash
   # Change the port mapping
   docker run -p 3001:3000 --env-file .env bundler-orchestrator
   ```

2. **Environment Variables Not Loading:**
   ```bash
   # Verify .env file exists and has correct format
   cat .env
   ```

3. **Permission Issues:**
   ```bash
   # The container runs as non-root user 'nextjs'
   # Ensure log directory permissions are correct
   sudo chown -R 1001:1001 logs/
   ```

### Debug Commands

```bash
# View container logs
docker logs <container-id>

# Access container shell
docker exec -it <container-id> sh

# Check container health
docker inspect <container-id> | grep Health -A 10
```

## 🔒 Security Best Practices

1. **Environment Variables:** Never commit `.env` files
2. **Non-root User:** Container runs as unprivileged user
3. **Health Checks:** Monitor application health
4. **Rate Limiting:** Built-in request rate limiting
5. **CORS:** Configured allowed origins
6. **Helmet:** Security headers middleware

## 📝 Available Scripts

- `npm run docker:build` - Build Docker image
- `npm run docker:run` - Run Docker container
- `npm run docker:dev` - Development with Docker Compose
- `npm run docker:prod` - Production with Docker Compose

## 🌍 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | - | Supabase anonymous key |
| `EXTERNAL_API_BASE_URL` | Yes | - | Blockchain primitives API URL |
| `FRONTEND_URL` | Yes | - | Frontend application URL |
| `PORT` | No | 3000 | Server port |
| `NODE_ENV` | No | production | Environment mode |
| `LOG_LEVEL` | No | info | Logging level |
| `ALLOWED_ORIGINS` | No | * | CORS allowed origins |
| `RATE_LIMIT_MAX` | No | 100 | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | No | 900000 | Rate limit window (15 min) |

## 📈 Performance

The Docker image is optimized for:
- **Small Size:** Alpine Linux base (~100MB)
- **Fast Startup:** Efficient dependency installation
- **Memory Usage:** Minimal resource footprint
- **Scalability:** Stateless design for horizontal scaling
