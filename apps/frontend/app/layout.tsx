import type { Metadata } from "next";
import { Bodoni_Moda, Montserrat, Raleway } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { SkinStyles, skinBranding } from "@/skin";

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-torrecid-sans",
  weight: ["300", "400", "500", "600", "700"]
});

const bodoniModa = Bodoni_Moda({
  subsets: ["latin"],
  variable: "--font-torrecid-serif",
  adjustFontFallback: false
});

const raleway = Raleway({
  subsets: ["latin"],
  variable: "--font-nutrex-sans",
  weight: ["400", "500", "600", "700"]
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
