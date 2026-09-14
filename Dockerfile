# Use a slim Python 3.11 base image
FROM python:3.11-slim

# Create a non-root user (Hugging Face runs as uid 1000)
RUN useradd -m -u 1000 user

# Set working directory
WORKDIR /app

# Install system dependencies needed by pdfplumber / pypdf
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies first (layer caching)
COPY --chown=user:user backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend source code
COPY --chown=user:user backend/ .

# Ensure the user has write access to the app directory (for ChromaDB)
RUN chown -R user:user /app

# Switch to the non-root user
USER user

# Hugging Face Spaces routes traffic to port 7860 by default
EXPOSE 7860

# Run the FastAPI server on port 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
