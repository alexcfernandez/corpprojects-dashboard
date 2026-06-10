# ESTADO DEL DASHBOARD — Corp Projects
*Actualizado: 10/06/2026*

Manual de operación: qué hay construido, dónde está cada interruptor y qué queda por encender.

---

## 1. MÓDULOS EN PRODUCCIÓN

### 💰 Cobros (avisos de facturas pendientes)
- Avisos por email con el PDF oficial de StelOrder dentro (enlace "Ver factura", no caduca).
- Agrupado semanal por familia o individual por factura, según configuración de cada familia (pestaña Familias).
- Herramientas de prueba en Familias → acordeón "🧪 Herramientas de prueba y previsualización".
- **Interruptor: pausa global de cobros → AHORA: PAUSADO.**

### 🔧 Pedidos de trabajo (pestaña Pedidos trabajo)
- Lista viva desde StelOrder (Pendiente/En curso) con días abiertos y semáforo.
- Umbrales: Actuación ámbar día 2, rojo día 3+ · Presupuesto ámbar día 7, rojo día 15+
  (env: WO_ACT_AMBER, WO_ACT_RED, WO_PRE_AMBER, WO_PRE_RED).
- Filtros por tipo, orden asc/desc, columna Asignado a + Prioridad (🔴 Urgente / 🔵 Normal).
- Aviso diario 08:00 a hola@corpprojects.es con rojos+ámbar y columna Asignado.
  **Interruptor: panel superior de la pestaña → AHORA: PAUSADO.**
- Vista "✅ Pte. facturar": pedidos completados por el trabajador, esperando factura.

### 📱 App del trabajador (parte.html, enlace /parte?w=...)
- Sesión persistente 7 días (env: WORKER_TOKEN_HOURS). PIN solo la primera vez o tras "Salir".
- "Mis pedidos": bloques 🔴 URGENTE / 🔵 OTROS, detalle "qué pidió el cliente".
- Cronómetro: ▶ Iniciar (persistente en servidor, aguanta cierres/batería) → ✓ Finalizar
  → parte pre-rellenado (cliente + horas reales redondeadas a media hora).
- El parte queda vinculado al pedido (banner azul). Estado del parte:
  · "Trabajo completado" → el pedido desaparece de su lista y pasa a "Pte. facturar" en admin.
  · "Continúa / Parcial / Necesito material" → sigue en su lista; el admin ve la nota (📦/🔴/🟡).

### 🔁 Ciclo completo pedido → factura
1. Incidencia entra en StelOrder → se genera PDT (la incidencia se cierra sola; vigilamos el PDT).
2. Admin asigna trabajador + prioridad.
3. Trabajador inicia (→ StelOrder "En curso" si escritura activa) y finaliza → parte.
4. Parte "completado" → admin ve "Pte. facturar".
5. Admin factura el parte (pestaña Partes → 💰 Facturado + referencia FAC)
   → el pedido se cierra en nuestra app (→ StelOrder "Cerrado" si escritura activa).

### ✍️ Escritura en StelOrder (Fase 4)
- **Interruptor: panel de la pestaña Pedidos → AHORA: DESACTIVADA.**
- Automatismos: iniciar→"En curso" (1120645) · parte facturado→"Cerrado" (1120638).
- Todo queda en la colección `stelWriteLog` (copia de seguridad incluida en pruebas manuales).
- Herramienta manual con verificación: acordeón "🧪 Prueba Fase 4" (acepta PDT o ID).
- PUT verificado como actualización parcial segura (4 pruebas OK el 10/06).

---

## 2. LISTA DE ENCENDIDOS (en orden)

- [ ] Limpiar pedidos antiguos en StelOrder (~111 críticos viejos).
- [ ] Devolver PDT00434 a "Cerrado" (quedó en Rechazado tras las pruebas).
- [ ] Activar avisos de pedidos (tras limpiar). Comprobar correo de las 08:00.
- [ ] Probar escritura StelOrder con un pedido real → si bien, dejar activada.
- [ ] Cobros: familias en Manual salvo Cinc (Jenny) → quitar pausa global → observar → ir sumando.
- [ ] Añadir a Alex y Alfonso como usuarios (para asignarles presupuestos).
- [ ] Rodaje real con David una semana.

## 3. ROADMAP (próximos bloques)

1. Notificaciones a cliente/familia por estado de incidencia (recibida → en camino →
   material pendiente → resuelta + foto). Destinatario: cliente y/o familia, pausas
   independientes. Contacto: ficha de cliente StelOrder o campo propio.
2. Contador diario de pedidos cerrados con éxito (presupuestos: cruzar con su presupuesto).
3. Versión imprimible del pedido/parte (transición al digital).
4. Facturación automática del parte completado — pendiente de: Fase 4 rodada + modo de
   facturación (Verifactu obligatorio 01/2027; hoy NO activo → verificar endpoint entonces).
5. Entrada automática de incidencias (corpprojects@inbox.stelorder.com ya las crea).
6. WhatsApp (Twilio): asistente de trabajadores 18:00 + avisos a clientes.
7. Nóminas · Flota/Quartix (coste por km) · BI/estimaciones · Base de conocimiento
   por comunidad · Rentabilidad por obra.

## 4. REFERENCIA RÁPIDA

| Cosa | Dónde |
|---|---|
| Pausa cobros | Familias (global y por familia) |
| Pausa avisos pedidos | Pedidos trabajo → panel superior |
| Escritura StelOrder | Pedidos trabajo → panel superior |
| Prueba estado StelOrder | Pedidos trabajo → 🧪 Prueba Fase 4 |
| Previsualizar correo cobros | Familias → 🧪 Herramientas |
| Datos crudos API | Familias → 🧪 (FAC/INC/PDT/ESTADOS-DOC/EMPLEADOS...) |
| Registro escrituras | Mongo → stelWriteLog |
| Tiempos reales trabajos | Mongo → workOrderTimers |
| Asignaciones y cierres | Mongo → workOrderAssignments |

**Estados StelOrder (workOrder):** Pendiente 1120651 · En curso 1120645 · Cerrado 1120638 · Rechazado 1120630
**Reglas de despliegue:** archivos completos siempre · verificar 1ª línea (ruta) antes de pegar · esperar deploy → Cmd+Shift+R.
