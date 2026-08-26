#!/usr/bin/env node
// Añade (o actualiza) un usuario en deploy/nginx/.htpasswd con hash bcrypt.
// Calcado de proan-hidrocarburos/scripts/htpasswd.mjs, con la resolución de
// bcryptjs adaptada: aquí el paquete vive en apps/frontend/node_modules, no en
// la raíz, así que se puede ejecutar en local sin levantar el contenedor.
//
//   node scripts/htpasswd.mjs jaime 'miClave'
//
// La contraseña queda en el historial del shell. Para evitarlo, pásala por
// variable de entorno (en PowerShell):
//
//   $env:HTPASSWD_PASS = Read-Host "Contraseña"
//   node scripts/htpasswd.mjs jaime
//   Remove-Item Env:HTPASSWD_PASS
//
// Uso: node scripts/htpasswd.mjs <usuario> [contraseña] [ruta-htpasswd]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [user, passArg, file = "deploy/nginx/.htpasswd"] = process.argv.slice(2);
const pass = passArg ?? process.env.HTPASSWD_PASS ?? "";

if (!user || !pass) {
  console.error("Uso: node scripts/htpasswd.mjs <usuario> [contraseña] [ruta-htpasswd]");
  console.error("     (sin contraseña, se lee de la variable HTPASSWD_PASS)");
  process.exit(1);
}

if (user.includes(":")) {
  // El fichero separa usuario y hash por el primer ':'; uno en el nombre
  // partiría la línea en el sitio equivocado.
  console.error("El usuario no puede contener ':'.");
  process.exit(1);
}

// bcryptjs se resuelve desde apps/frontend, que es quien lo tiene instalado
// (es la misma dependencia que usa el login en tiempo de ejecución).
const require = createRequire(new URL("../apps/frontend/package.json", import.meta.url));
const bcrypt = require("bcryptjs");

const COST = 12;
const hash = bcrypt.hashSync(pass, COST);

// Si el usuario ya estaba, su línea se reemplaza en vez de duplicarse: el login
// se queda con la primera coincidencia, así que una línea vieja arriba ganaría.
const previas = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
const conservadas = previas.filter((linea) => linea.split(":")[0] !== user);
const actualizado = previas.length !== conservadas.length;

// Salto de línea Unix y fichero terminado en salto: acaba montado desde Secret
// Manager y leído dentro del contenedor.
writeFileSync(file, [...conservadas, `${user}:${hash}`].filter(Boolean).join("\n") + "\n", {
  encoding: "utf8"
});

console.log(`${actualizado ? "Actualizado" : "Añadido"} '${user}' en ${file} (bcrypt, coste ${COST})`);
