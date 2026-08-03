/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

