# Puente WhatsApp (Baileys) — pull / solo-salida

Servicio que conecta el **número nuevo** de WhatsApp con el dashboard de Corp,
**sin exponer ningún puerto**. Solo hace llamadas salientes:

- **Salida:** sondea `GET DASHBOARD_URL/api/bridge/outbox` cada ~2 s y envía cada
  mensaje por WhatsApp (Baileys).
- **Entrada:** cada mensaje 1-a-1 que llega al número → `POST DASHBOARD_URL/api/bridge/inbound`.
- **Auth:** header `X-Bridge-Token: <BRIDGE_TOKEN>` (el mismo secreto que en el dashboard).

> Incremento 1: **solo texto** y **solo chats 1-a-1**. Grupos = incremento 2.

## Requisitos previos (en el dashboard)
1. Poner `BRIDGE_TOKEN=<secreto largo aleatorio>` en las variables del dashboard (Railway).
2. **No** cambiar `CANAL_WHATSAPP` todavía (sigue en `twilio`). Se pone `bridge`
   cuando el puente esté vinculado y probado.

## Desplegar en el Docker Manager de Hostinger (como un proyecto nuevo, igual que n8n)

1. Sube esta carpeta `bridge/` al VPS (o clona el repo y entra en `bridge/`).
2. Crea un fichero `.env` junto al `docker-compose.yml` (copia de `.env.example`):
   ```
   DASHBOARD_URL=https://dashboard.corpprojects.es
   BRIDGE_TOKEN=el-mismo-secreto-del-dashboard
   POLL_MS=2000
   ```
3. En **hPanel → Docker Manager → Crear proyecto**, apunta al `docker-compose.yml`
   de esta carpeta (o, por SSH: `docker compose up -d --build`).
4. El contenedor arranca. **No publica puertos** (es intencionado).

## Vincular el número (escanear el QR) — solo la primera vez

1. Abre los **logs** del contenedor (Docker Manager → el proyecto → Logs; o
   `docker compose logs -f bridge`).
2. Verás un **código QR** en ASCII con el texto *"Escanea este QR…"*.
3. En el móvil con el **número nuevo**: WhatsApp → **Dispositivos vinculados** →
   **Vincular un dispositivo** → escanea el QR de los logs.
4. Cuando lo veas, el log dirá `Conectado a WhatsApp ✅`.
5. La sesión queda guardada en el volumen `bridge_auth` → **no** vuelve a pedir QR
   al reiniciar. (Si algún día sale `loggedOut`, borra el volumen y repite el QR.)

## Prueba por pasos (con Twilio de respaldo activo)
1. **Salida:** con `CANAL_WHATSAPP=bridge` en el dashboard, lanza el aviso de
   presencia en modo prueba: `GET /api/presencia/aviso?dry=1` (ver a quién iría) y
   luego un envío real → debe llegar **desde el número nuevo**.
2. **Entrada:** escríbele al número nuevo desde tu móvil (owner) → el bot responde;
   luego desde un trabajador → acuse + reenvío (como en Fase 3).
3. Si algo falla, `CANAL_WHATSAPP=twilio` vuelve a Twilio al instante.

## Notas
- El puente no guarda datos de negocio; solo la sesión de WhatsApp (volumen).
- Si el dashboard está caído o el token no coincide, el puente reintenta y lo
  registra en los logs (`outbox 401` = token mal; `outbox error` = red/caído).
- Heartbeat: cada sondeo actualiza `bridgeStatus.lastSeen` en el dashboard; sirve
  para alertar si el puente deja de sondear (alerta = trabajo futuro).
