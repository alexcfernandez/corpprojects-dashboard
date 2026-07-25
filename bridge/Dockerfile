FROM node:20-slim

WORKDIR /app

# Instala dependencias primero (mejor caché)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

# Sesión de WhatsApp persistida en un volumen (no re-escanear QR en cada reinicio)
ENV AUTH_DIR=/data/auth
VOLUME ["/data/auth"]

# Sin EXPOSE ni puertos: el puente SOLO hace llamadas salientes.
CMD ["node", "index.js"]
