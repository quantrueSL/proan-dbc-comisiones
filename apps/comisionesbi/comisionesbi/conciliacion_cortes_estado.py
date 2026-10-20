"""Conciliación por cortes — estado que decide el usuario (Firestore).

Qué se guarda y qué no: BigQuery sigue siendo la fuente de lo calculado y lo
pagado; aquí solo viven las decisiones — qué ventana se le dio a cada pago, qué
sugerencias se descartaron y (fase 5) qué pagos se consolidaron — más un
historial de cambios. Todo se guarda contra el `pago_id` (documento de SAP), no
contra el texto del pago, así que sobrevive a una recarga de BSAK.

Un documento por fila (sociedad × comisionista × división):

  conc_filas/{sociedad}|{comisionista_id}|{division}
    version         int, sube en cada escritura (control optimista)
    overrides       {pago_id: {"ini": "AAAA-MM-DD", "fin": "AAAA-MM-DD"}}
    descartadas     {pago_id: {"por": usuario, "ts": iso}}
    dias_asignados  {pago_id: ["AAAA-MM-DD", ...]}  días sueltos (cierre de mes) que se le suman a un pago
    consolidados    {pago_id: {"ini", "fin", "pagado", "calculado", "por", "ts"}}
    comentarios     {pago_id: [{"id", "texto", "por", "ts"}, ...]}  notas de quien concilia (p. ej. un error humano)
    actualizado_por / actualizado_en
    eventos/{auto}  tipo, usuario, ts, pago_id, antes, despues (solo se agrega)

Control de concurrencia: cada escritura dice qué `version` vio; si otra persona
escribió antes, la transacción falla con `ConflictoVersion` y la pantalla recarga.

Variables de entorno:
  CONCILIACION_FIRESTORE_DATABASE_ID  (por defecto "dbc-comisiones")
  BQ_PROJECT_ID                       el mismo proyecto que BigQuery
  BQ_CREDENTIALS_PATH                 opcional: el mismo fichero de cuenta de servicio que BigQuery
  CONCILIACION_ESTADO_BACKEND         "memory" para trabajar sin Firestore (desarrollo y pruebas)
"""

from __future__ import annotations

import copy
import logging
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Iterable

from comisionesbi.conciliacion_cortes_engine import EstadoFila, FilaKey, Foto

log = logging.getLogger(__name__)

COLECCION = "conc_filas"
COLECCION_EVENTOS = "eventos"


class FirestoreError(RuntimeError):
    """Falló el acceso a Firestore (permisos, servicio caído, configuración)."""


class ConflictoVersion(RuntimeError):
    """Otra persona cambió la fila entre que se leyó y se quiso escribir."""

    codigo = "conflicto_version"


def doc_id(key: FilaKey) -> str:
    sociedad, comisionista_id, division = key
    return f"{sociedad}|{comisionista_id}|{division or '-'}"


@dataclass
class DocFila:
    version: int = 0
    overrides: dict[str, dict[str, date]] = field(default_factory=dict)
    descartadas: dict[str, dict] = field(default_factory=dict)
    consolidados: dict[str, Foto] = field(default_factory=dict)
    # Quién consolidó cada pago y cuándo: {pago_id: {"por": usuario, "ts": iso}}.
    consolidados_info: dict[str, dict] = field(default_factory=dict)
    dias_asignados: dict[str, list[date]] = field(default_factory=dict)
    comentarios: dict[str, list[dict]] = field(default_factory=dict)

    def a_estado(self) -> EstadoFila:
        return EstadoFila(
            overrides={k: dict(v) for k, v in self.overrides.items()},
            consolidados=dict(self.consolidados),
            descartadas=set(self.descartadas),
            dias_asignados={k: list(v) for k, v in self.dias_asignados.items()},
        )

    # --- Firestore guarda fechas como texto ISO ---

    def a_dict(self) -> dict:
        return {
            "version": self.version,
            "overrides": {k: {b: f.isoformat() for b, f in v.items()} for k, v in self.overrides.items()},
            "descartadas": self.descartadas,
            "dias_asignados": {k: [d.isoformat() for d in v] for k, v in self.dias_asignados.items()},
            "comentarios": self.comentarios,
            "consolidados": {
                k: {
                    "ini": f.ini.isoformat(),
                    "fin": f.fin.isoformat(),
                    "pagado": f.pagado,
                    "calculado": f.calculado,
                    **(self.consolidados_info.get(k) or {}),
                }
                for k, f in self.consolidados.items()
            },
        }

    @classmethod
    def desde_dict(cls, datos: dict | None) -> "DocFila":
        datos = datos or {}
        return cls(
            version=int(datos.get("version") or 0),
            overrides={
                k: {b: date.fromisoformat(f) for b, f in v.items()}
                for k, v in (datos.get("overrides") or {}).items()
            },
            descartadas=dict(datos.get("descartadas") or {}),
            comentarios={k: [dict(c) for c in v] for k, v in (datos.get("comentarios") or {}).items()},
            dias_asignados={
                k: [date.fromisoformat(d) for d in v] for k, v in (datos.get("dias_asignados") or {}).items()
            },
            consolidados={
                k: Foto(
                    date.fromisoformat(v["ini"]),
                    date.fromisoformat(v["fin"]),
                    float(v["pagado"]),
                    float(v["calculado"]),
                )
                for k, v in (datos.get("consolidados") or {}).items()
            },
            consolidados_info={
                k: {c: v[c] for c in ("por", "ts") if v.get(c) is not None}
                for k, v in (datos.get("consolidados") or {}).items()
            },
        )


def ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ─── Implementación en memoria (desarrollo y pruebas) ────────────────────


class MemoriaStore:
    def __init__(self) -> None:
        self.filas: dict[str, dict] = {}
        self.eventos: dict[str, list[dict]] = {}

    def leer(self, keys: Iterable[FilaKey]) -> dict[FilaKey, DocFila]:
        out = {}
        for k in keys:
            d = self.filas.get(doc_id(k))
            if d is not None:
                out[k] = DocFila.desde_dict(copy.deepcopy(d))
        return out

    def escribir(self, key: FilaKey, version_esperada: int, nuevo: DocFila, evento: dict) -> DocFila:
        actual = int((self.filas.get(doc_id(key)) or {}).get("version") or 0)
        if actual != version_esperada:
            raise ConflictoVersion("La fila cambió mientras la editabas.")
        nuevo.version = actual + 1
        self.filas[doc_id(key)] = copy.deepcopy(nuevo.a_dict())
        self.eventos.setdefault(doc_id(key), []).append({**evento, "version": nuevo.version})
        return nuevo

    def historial(self, key: FilaKey, limite: int) -> list[dict]:
        return list(reversed(self.eventos.get(doc_id(key), [])))[:limite]


# ─── Firestore ───────────────────────────────────────────────────────────


class FirestoreStore:
    def __init__(self) -> None:
        self._cliente = None

    def _db(self):
        if self._cliente is None:
            from google.auth.exceptions import GoogleAuthError  # type: ignore

            try:
                from google.cloud import firestore  # type: ignore
            except ImportError as exc:
                # Pasa si la imagen se construyó antes de agregar la dependencia.
                raise FirestoreError(
                    "Falta la librería google-cloud-firestore en el servicio: hay que reconstruir la imagen."
                ) from exc

            proyecto = os.getenv("BQ_PROJECT_ID", "").strip()
            if not proyecto:
                raise FirestoreError("BQ_PROJECT_ID no está definida: no se puede abrir Firestore.")
            base = os.getenv("CONCILIACION_FIRESTORE_DATABASE_ID", "dbc-comisiones").strip()
            credenciales = None  # None: credenciales de aplicación (Cloud Run, o las de la máquina en local)
            ruta = os.getenv("BQ_CREDENTIALS_PATH")
            if ruta:
                # Mismo fichero que BigQuery (desarrollo con Docker): una sola cuenta para los dos.
                from google.oauth2 import service_account  # type: ignore

                try:
                    credenciales = service_account.Credentials.from_service_account_file(
                        ruta, scopes=["https://www.googleapis.com/auth/cloud-platform"]
                    )
                except (OSError, ValueError) as exc:
                    raise FirestoreError(f"No se pudieron cargar las credenciales de {ruta}: {exc}") from exc
            try:
                self._cliente = firestore.Client(project=proyecto, database=base, credentials=credenciales)
            except GoogleAuthError as exc:
                raise FirestoreError(f"No hay credenciales utilizables para Firestore: {exc}") from exc
            log.info("Cliente de Firestore creado (proyecto=%s, base=%s)", proyecto, base)
        return self._cliente

    def leer(self, keys: Iterable[FilaKey]) -> dict[FilaKey, DocFila]:
        from google.api_core.exceptions import GoogleAPIError  # type: ignore

        keys = list(keys)
        if not keys:
            return {}
        try:
            db = self._db()
            refs = [db.collection(COLECCION).document(doc_id(k)) for k in keys]
            por_id = {snap.id: snap for snap in db.get_all(refs) if snap.exists}
        except GoogleAPIError as exc:
            log.exception("Fallo leyendo el estado de las filas en Firestore")
            raise FirestoreError("No se pudo leer el estado guardado de las filas.") from exc
        return {k: DocFila.desde_dict(por_id[doc_id(k)].to_dict()) for k in keys if doc_id(k) in por_id}

    def escribir(self, key: FilaKey, version_esperada: int, nuevo: DocFila, evento: dict) -> DocFila:
        from google.api_core.exceptions import GoogleAPIError  # type: ignore
        from google.cloud import firestore  # type: ignore

        db = self._db()
        ref = db.collection(COLECCION).document(doc_id(key))
        ref_evento = ref.collection(COLECCION_EVENTOS).document()

        @firestore.transactional
        def _tx(tx):
            snap = ref.get(transaction=tx)
            actual = int((snap.to_dict() or {}).get("version") or 0) if snap.exists else 0
            if actual != version_esperada:
                raise ConflictoVersion("La fila cambió mientras la editabas.")
            nuevo.version = actual + 1
            datos = nuevo.a_dict()
            datos["actualizado_por"] = evento.get("usuario")
            datos["actualizado_en"] = firestore.SERVER_TIMESTAMP
            tx.set(ref, datos)
            tx.set(ref_evento, {**evento, "version": nuevo.version, "ts": firestore.SERVER_TIMESTAMP})

        try:
            _tx(db.transaction())
        except GoogleAPIError as exc:
            log.exception("Fallo escribiendo la fila %s en Firestore", doc_id(key))
            raise FirestoreError("No se pudo guardar el cambio.") from exc
        return nuevo

    def historial(self, key: FilaKey, limite: int) -> list[dict]:
        from google.api_core.exceptions import GoogleAPIError  # type: ignore
        from google.cloud import firestore  # type: ignore

        try:
            ref = self._db().collection(COLECCION).document(doc_id(key)).collection(COLECCION_EVENTOS)
            snaps = ref.order_by("ts", direction=firestore.Query.DESCENDING).limit(limite).stream()
            salida = []
            for s in snaps:
                d = s.to_dict() or {}
                ts = d.get("ts")
                d["ts"] = ts.isoformat() if hasattr(ts, "isoformat") else ts
                salida.append(d)
            return salida
        except GoogleAPIError as exc:
            log.exception("Fallo leyendo el historial de %s", doc_id(key))
            raise FirestoreError("No se pudo leer el historial.") from exc


_store = None


def get_store():
    """El almacén de estado: Firestore, o memoria si CONCILIACION_ESTADO_BACKEND=memory."""
    global _store
    if _store is None:
        _store = MemoriaStore() if os.getenv("CONCILIACION_ESTADO_BACKEND") == "memory" else FirestoreStore()
    return _store
