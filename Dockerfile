# Stage 1: Build the React frontend
FROM node:20 AS frontend-builder
WORKDIR /app

# Enable Railway to inject the Clerk publishable key during Vite build
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY

COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Stage 2: Build the Python backend
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies needed for audio processing and TensorFlow
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 300 -r requirements.txt

# Copy all backend source code
COPY . .

# Copy the built frontend static files from Stage 1
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Expose port and configure start command
EXPOSE ${PORT:-5000}
CMD ["sh", "-c", "gunicorn wsgi:app --bind 0.0.0.0:${PORT:-5000}"]
