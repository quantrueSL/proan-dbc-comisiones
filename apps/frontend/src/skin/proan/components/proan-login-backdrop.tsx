// Fondo animado del login: la red de distribución de DBC.
//
// El motivo es el del propio producto — producto que sale de planta y llega a
// los CEDIS — en vez de una animación decorativa cualquiera. Un hub a la
// izquierda, cinco CEDIS a la derecha, y producto circulando por las rutas.
//
// Todo es CSS sobre un SVG estático, así que esto sigue siendo un componente de
// servidor: cero JavaScript en el navegador. Las cajas que viajan usan
// `offset-path`, detrás de un `@supports`: donde no exista, simplemente no
// aparecen y quedan las rutas fluyendo. Y con `prefers-reduced-motion` se
// detiene todo (ver globals.css).
//
// `aria-hidden`: es decoración, no información. Un lector de pantalla que lo
// anunciara solo estorbaría a quien viene a escribir su contraseña.

const RUTAS = [
  { d: "M170 400 C 380 400, 470 180, 700 168", retraso: "0s" },
  { d: "M170 400 C 400 400, 500 300, 760 286", retraso: "1.1s" },
  { d: "M170 400 C 420 400, 520 400, 800 400", retraso: "2.2s" },
  { d: "M170 400 C 400 400, 500 500, 760 514", retraso: "0.6s" },
  { d: "M170 400 C 380 400, 470 620, 700 632", retraso: "1.7s" }
];

const CEDIS = [
  { cx: 700, cy: 168 },
  { cx: 760, cy: 286 },
  { cx: 800, cy: 400 },
  { cx: 760, cy: 514 },
  { cx: 700, cy: 632 }
];

export function ProanLoginBackdrop() {
  return (
    <div aria-hidden="true" className="login-backdrop">
      <svg viewBox="0 0 960 800" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#5f62d0" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#5f62d0" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="170" cy="400" r="260" fill="url(#halo)" />

        {RUTAS.map((ruta) => (
          <g key={ruta.d}>
            {/* Traza fija, muy tenue: la red existe aunque no circule nada. */}
            <path className="login-map-route" d={ruta.d} />
            {/* Traza que fluye: el producto avanzando hacia el CEDIS. */}
            <path className="login-map-flow" d={ruta.d} style={{ animationDelay: ruta.retraso }} />
            <rect
              className="login-map-box"
              width="11"
              height="9"
              rx="2"
              style={{ offsetPath: `path("${ruta.d}")`, animationDelay: ruta.retraso }}
            />
          </g>
        ))}

        {/* Planta de origen */}
        <g className="login-map-hub">
          <circle cx="170" cy="400" r="26" />
          <circle className="login-map-pulse" cx="170" cy="400" r="26" />
        </g>

        {/* CEDIS de destino */}
        {CEDIS.map((nodo, i) => (
          <circle
            className="login-map-node"
            key={`${nodo.cx}-${nodo.cy}`}
            cx={nodo.cx}
            cy={nodo.cy}
            r="9"
            style={{ animationDelay: `${i * 0.45}s` }}
          />
        ))}
      </svg>
    </div>
  );
}
