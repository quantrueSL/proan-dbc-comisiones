/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` y `next build` escriben en el MISMO directorio. Lanzar un build
  // de comprobación con el servidor de desarrollo levantado le sobrescribe los
  // manifiestos, y la página se queda sin CSS: el HTML pide unos chunks que en
  // desarrollo no existen. Pasa sin ningún error a la vista, que es lo peor.
  //
  // Con esto, una comprobación puede ir a otro sitio y no molestar:
  //   NEXT_DIST_DIR=.next-check pnpm build
  // Por defecto sigue siendo `.next`, que es lo que copia el Dockerfile.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Standalone output: production Dockerfile copies .next/standalone
  // (self-contained server + traced node_modules) instead of full node_modules.
  // Does not affect `next dev` in the dev container.
  output: "standalone",
  images: {
    // En modo standalone, `next/image` exige `sharp` instalado o falla en
    // ejecución al optimizar. Las únicas imágenes son el logo y el icono de
    // Proan: PNG pequeños y estáticos, donde optimizar no aporta nada. Se
    // desactiva y así no hace falta una dependencia nativa (con sus binarios
    // por plataforma) dentro de la imagen Alpine.
    unoptimized: true
  }
};

export default nextConfig;

