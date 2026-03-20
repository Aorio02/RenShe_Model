import { PropsWithChildren } from 'react';

export function PageHeader({ children }: PropsWithChildren) {
  return (
    <header className="flex justify-between items-center bg-transparent p-5 text-white">
      {children}
    </header>
  );
}
