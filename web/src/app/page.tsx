'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  const { session, ready } = useSession();

  useEffect(() => {
    if (!ready) return;
    router.replace(session ? '/workflows' : '/login');
  }, [ready, session, router]);

  return (
    <div className="center-page">
      <span className="muted">loading…</span>
    </div>
  );
}
