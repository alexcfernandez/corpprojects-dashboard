// src/zip.js — ZIP mínimo (sin compresión, método STORE) para empaquetar PDFs.
// Los PDF ya van comprimidos, así que no compensa añadir una dependencia para deflate.
//   crearZip([{ nombre: 'carpeta/archivo.pdf', datos: Buffer }]) → Buffer

const TABLA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function fechaDos(d = new Date()) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, dia };
}

function crearZip(archivos) {
  const partes = [], centrales = [];
  let offset = 0;
  const { hora, dia } = fechaDos();
  for (const a of archivos) {
    const nombre = Buffer.from(String(a.nombre), 'utf8');
    const datos = Buffer.isBuffer(a.datos) ? a.datos : Buffer.from(a.datos);
    const crc = crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); local.writeUInt16LE(hora, 10); local.writeUInt16LE(dia, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(datos.length, 18); local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombre.length, 26); local.writeUInt16LE(0, 28);
    partes.push(local, nombre, datos);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(hora, 12); central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(datos.length, 20); central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombre.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre);
    offset += local.length + nombre.length + datos.length;
  }
  const dirCentral = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(0, 4); fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(dirCentral.length, 12); fin.writeUInt32LE(offset, 16); fin.writeUInt16LE(0, 20);
  return Buffer.concat([...partes, dirCentral, fin]);
}

module.exports = { crearZip, crc32 };
