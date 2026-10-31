export function BetaNotice({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="relative rounded-sm border border-ink/80 bg-paper p-5 shadow-[6px_6px_0_0_var(--color-ink)] sm:p-7">
      <h2 className="font-display text-3xl leading-none">Pedí un chequeo</h2>
      <p className="mt-5 leading-relaxed text-ink-soft">
        Grokeado está en beta. Para pedir un chequeo, enviá un correo a{" "}
        <a href="mailto:grokeado@grokeado.com" className="font-medium text-celeste-deep underline">grokeado@grokeado.com</a>.
      </p>
      {signedIn ? (
        <a href="/auth/logout?returnTo=/" className="mt-5 inline-block text-sm text-ink-soft underline">Cerrar sesión</a>
      ) : (
        <a href="/auth/login?returnTo=/" className="mt-5 inline-block text-sm text-ink-soft underline">Iniciá sesión</a>
      )}
    </div>
  );
}
