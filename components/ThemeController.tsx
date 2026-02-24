'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export default function ThemeController() {
  const pathname = usePathname();

  useEffect(() => {
    const isInvest = pathname.startsWith('/invest');
    const theme = isInvest ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }, [pathname]);

  return null;
}
