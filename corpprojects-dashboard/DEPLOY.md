# 🚀 Guía de despliegue — Corp Projects Dashboard

## PASO 1 — Subir el código a GitHub

1. Ve a https://github.com/new
2. Nombre del repositorio: `corpprojects-dashboard`
3. Selecciona **Private** (muy importante)
4. Pulsa "Create repository"
5. Sigue las instrucciones que te da GitHub para subir los archivos

## PASO 2 — Crear el proyecto en Railway

1. Ve a https://railway.app
2. New Project → Deploy from GitHub repo
3. Selecciona `corpprojects-dashboard`
4. Railway detectará automáticamente que es Node.js

## PASO 3 — Configurar las variables de entorno en Railway

En Railway → tu proyecto → Variables, añade una por una:

```
STELORDER_API_KEY        = [tu nueva api key de stelorder]
DASHBOARD_PASSWORD       = [elige una contraseña para el dashboard]
JWT_SECRET               = [cadena aleatoria larga, ej: corpprojects2026xK9mP3qR]
EMAIL_USER               = hola@corpprojects.es
EMAIL_PASS               = [contraseña del email o App Password]
EMAIL_FROM               = Corp Projects <hola@corpprojects.es>
EMAIL_HOST               = mail.corpprojects.es
EMAIL_PORT               = 587
EMAIL_ADMIN              = corpy@corpprojects.es
ALERT_WARNING_DAYS       = 15
ALERT_SECOND_DAYS        = 30
ALERT_URGENT_DAYS        = 45
ALERT_CRITICAL_DAYS      = 60
NODE_ENV                 = production
```

## PASO 4 — Dominio personalizado en Railway

1. Railway → tu proyecto → Settings → Domains
2. Add Custom Domain → escribe: `dashboard.corpprojects.es`
3. Railway te dará un valor CNAME, algo como: `xxx.railway.app`

## PASO 5 — Apuntar el DNS en SiteGround

1. SiteGround → Websites → corpprojects.es → DNS Zone Editor
2. Busca el registro del subdominio `dashboard` que creaste antes
3. Cámbialo de tipo A a tipo CNAME
4. Valor: pega la URL que te dio Railway (sin https://)
5. Guarda — puede tardar 5-30 minutos en propagarse

## PASO 6 — Verificar que funciona

Abre https://dashboard.corpprojects.es
Deberías ver la pantalla de login de Corp Projects.

## PASO 7 — WhatsApp con Twilio (una vez que todo lo anterior funcione)

1. Ve a https://twilio.com → Create account (gratis)
2. Activa el Sandbox de WhatsApp
3. Sigue las instrucciones para vincular tu número
4. Añade en Railway:
   ```
   TWILIO_ACCOUNT_SID   = [tu SID de Twilio]
   TWILIO_AUTH_TOKEN    = [tu token de Twilio]
   TWILIO_WHATSAPP_FROM = whatsapp:+14155238886
   WHATSAPP_TO          = whatsapp:+34[tu número]
   ```
5. En el dashboard → pestaña Alertas → Test WhatsApp

---

## ¿Problemas?

- Railway → tu proyecto → Deployments → ver logs en tiempo real
- Si el login no funciona: verifica que DASHBOARD_PASSWORD está bien escrita
- Si StelOrder no carga: verifica que STELORDER_API_KEY es la nueva que generaste
