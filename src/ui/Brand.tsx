// Branding pieces shared by the app shell, the sign-in pages and the phone pages. All text comes from src/brand.ts.
import type { ReactNode } from 'react';
import { BRAND, copyrightLine } from '../brand';

/** The square logo mark (monogram on the brand colour). Follows the --brand colour so it also suits dark mode. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return <div className="logo" role="img" aria-label={BRAND.name} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}><span className="logo-tc">{BRAND.monogram}</span></div>;
}

/** Sign-in / password / error pages: the card, with the copyright line under it. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-stack">
        {children}
        <div className="auth-foot">{copyrightLine()}</div>
      </div>
    </div>
  );
}
