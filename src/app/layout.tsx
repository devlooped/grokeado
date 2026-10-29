import type { Metadata } from "next";
import Link from "next/link";
import { Archivo, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import "./globals.css";

const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "Grokeado · Panel de chequeo de datos",
  description: "Tres inteligencias artificiales investigan, debaten y votan. Un moderador desempata cuando no hay mayoría. Sin sesgos humanos.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" data-theme="light" suppressHydrationWarning className={`${instrument.variable} ${archivo.variable} ${plexMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const saved=localStorage.getItem("theme");document.documentElement.dataset.theme=saved==="dark"||saved==="light"?saved:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch{document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}`,
          }}
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <header className="mx-auto max-w-5xl px-5 pt-6">
          <div className="flex items-baseline justify-between gap-4 text-[11px] uppercase tracking-[0.2em] text-ink-soft">
            <span>República Argentina</span>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline">Panel de chequeo de datos</span>
              <ThemeToggle />
            </div>
          </div>
          <Link href="/" className="mt-2 block text-center">
            <span className="font-display text-6xl leading-none tracking-tight sm:text-7xl">Grokeado</span>
          </Link>
          <p className="mt-1 text-center font-display text-lg italic text-ink-soft">Tres inteligencias debaten. Un moderador desempata. Ningún humano opina.</p>
          <div className="rule-double mt-4" />
        </header>
        <main className="mx-auto max-w-5xl px-5 pb-24">{children}</main>
        <footer className="mx-auto max-w-5xl px-5 pb-10 text-xs text-ink-soft">
          <div className="border-t border-rule pt-4">
            Analistas: Grok, Gemini y Claude. Moderador: Grok. Cada voto y cada decisión queda en el registro público del debate.
          </div>
        </footer>
      </body>
    </html>
  );
}
