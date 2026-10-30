import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import { SkinStyles, skinBranding } from "@/skin";

// Fuentes guardadas en el repo (subconjunto latino de Google Fonts, variables: un archivo cubre todos los pesos).
// Con next/font/google el build las descargaba cada vez y fallaba cuando Google respondía raro a Cloud Build.
const montserrat = localFont({
  src: "./fonts/montserrat-latin.woff2",
  variable: "--font-torrecid-sans",
  weight: "300 700",
  display: "swap"
});

const bodoniModa = localFont({
  src: "./fonts/bodoni-moda-latin.woff2",
  variable: "--font-torrecid-serif",
  weight: "400 900",
  display: "swap",
  adjustFontFallback: false
});

const raleway = localFont({
  src: "./fonts/raleway-latin.woff2",
  variable: "--font-nutrex-sans",
  weight: "400 700",
  display: "swap"
});

export const metadata: Metadata = {
  title: skinBranding.metadataTitle,
  description: skinBranding.metadataDescription
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      className={`${montserrat.variable} ${bodoniModa.variable} ${raleway.variable}`}
      lang="es"
    >
      <body>
        <SkinStyles />
        {children}
      </body>
    </html>
  );
}
