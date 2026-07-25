FROM node:20-slim

WORKDIR /app

# Baileys resuelve alguna dependencia por git → hace falta git en la imagen slim.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Instala dependencias primero (mejor caché)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

# Sesión de WhatsApp persistida en un volumen (no re-escanear QR en cada reinicio)
ENV AUTH_DIR=/data/auth
VOLUME ["/data/auth"]

# Sin EXPOSE ni puertos: el puente SOLO hace llamadas salientes.
CMD ["node", "index.js"]
